import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { CONFIG_KEYS, loadConfig } from '../src/config/configFile.js'

// config.schema.json, the schema editors check a --config file against: it is
// the loader's own keys, the shipped file is the generated one, and what the
// loader takes, the schema takes.

type Schema = Record<string, any>

// Loaded inside the tests that use it. The gateway never loads this module,
// so it only runs here, and the coverage gate counts what runs within a
// test, not what a test file's own imports run while the file loads.
const generator = () => import('../src/config/configSchema.js')

const shipped: Schema = JSON.parse(readFileSync('config.schema.json', 'utf8'))

// The part of JSON Schema (draft-07) the generator uses, and no more: what
// is wrong with `value`, as paths.
function problems(
  schema: Schema,
  value: unknown,
  root: Schema,
  at = '$',
): string[] {
  if (schema.$ref)
    return problems(
      root.definitions[schema.$ref.replace('#/definitions/', '')],
      value,
      root,
      at,
    )
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(
      (option: Schema) => problems(option, value, root, at).length === 0,
    )
    return passing.length === 1
      ? []
      : [`${at}: matches ${passing.length} of oneOf`]
  }
  const found: string[] = []
  const isObject =
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const type = Array.isArray(value)
    ? 'array'
    : isObject
      ? 'object'
      : Number.isInteger(value)
        ? 'integer'
        : typeof value
  if (schema.type && schema.type !== type) return [`${at}: not ${schema.type}`]
  if (schema.enum && !schema.enum.includes(value))
    found.push(`${at}: not in enum`)
  if (schema.pattern && !new RegExp(schema.pattern).test(value as string))
    found.push(`${at}: does not match ${schema.pattern}`)
  if (schema.minimum !== undefined && (value as number) < schema.minimum)
    found.push(`${at}: below ${schema.minimum}`)
  if (Array.isArray(value) && schema.items)
    value.forEach((item, i) =>
      found.push(...problems(schema.items, item, root, `${at}[${i}]`)),
    )
  if (isObject) {
    for (const key of schema.required ?? [])
      if (!(key in (value as object))) found.push(`${at}: lacks ${key}`)
    for (const [key, item] of Object.entries(value as object)) {
      const property = schema.properties?.[key]
      if (property)
        found.push(...problems(property, item, root, `${at}.${key}`))
      else if (schema.additionalProperties === false)
        found.push(`${at}.${key}: unknown key`)
      else if (schema.additionalProperties)
        found.push(
          ...problems(schema.additionalProperties, item, root, `${at}.${key}`),
        )
    }
  }
  return found
}

const loads = (value: unknown) =>
  'config' in loadConfig('servers.json', JSON.stringify(value), {})

test('the shipped config.schema.json is the generated one', async () => {
  const { configSchema } = await generator()
  assert.deepEqual(
    shipped,
    configSchema(),
    'config.schema.json is stale: run `npm run schema`',
  )
})

test("each level has exactly the keys the loader takes there, and other clients' keys", () => {
  const keys = (schema: Schema) => Object.keys(schema.properties).sort()
  const expected = (level: string[]) =>
    [...new Set([...level, ...CONFIG_KEYS.clientOnly])].sort()
  assert.deepEqual(keys(shipped), expected(CONFIG_KEYS.top))
  assert.deepEqual(
    keys(shipped.definitions.server),
    expected(CONFIG_KEYS.entry),
  )
  assert.deepEqual(
    keys(shipped.definitions.combinedServer),
    expected(CONFIG_KEYS.inner),
  )
  for (const level of [
    shipped,
    shipped.definitions.server,
    shipped.definitions.combinedServer,
  ])
    assert.equal(level.additionalProperties, false)
  // Every key the gateway reads says what it is for.
  for (const level of [shipped, shipped.definitions.server])
    for (const [key, property] of Object.entries<Schema>(level.properties))
      assert.equal(typeof property.description, 'string', key)
  assert.deepEqual(
    shipped.properties.outputTransport.enum,
    CONFIG_KEYS.transports,
  )
  assert.deepEqual(shipped.definitions.server.properties.type.enum, [
    'stdio',
    ...CONFIG_KEYS.urlTypes,
  ])
})

// Files the loader takes: the schema must take them too.
const valid: Record<string, unknown> = {
  'a Claude Desktop file': {
    mcpServers: {
      git: { command: 'uvx', args: ['mcp-server-git', ''], env: { A: 'b' } },
      files: { command: 'npx', args: [], cwd: '/tmp', autoApprove: ['read'] },
    },
  },
  'every gateway and endpoint option': {
    $schema: 'https://example.com/config.schema.json',
    port: 0,
    host: '127.0.0.1',
    logLevel: 'debug',
    logFormat: 'json',
    exitWithProcess: 2,
    healthEndpoint: ['/healthz', '/readyz'],
    outputTransport: 'streamableHttp',
    baseUrl: 'https://public.example',
    ssePath: '/events',
    messagePath: '/messages',
    streamableHttpPath: '/rpc',
    cors: ['https://a.example', '/b$/'],
    healthCheck: 'server',
    toolPrefix: 'gh_',
    tools: [],
    apiKey: ['one', 'two'],
    apiKeyFile: '/run/keys',
    stateful: true,
    sessionTimeout: 1,
    protocolVersion: '2025-06-18',
    headers: { 'x-team': 'core' },
    oauth2Bearer: 'token',
    timeout: 30,
    mcpServers: {
      one: {
        stdio: 'server --flag',
        path: '/first',
        cors: true,
        healthEndpoint: '/healthz',
        apiKey: 'single',
        enabled: true,
      },
      two: { url: 'https://remote.example/mcp', type: 'http', disabled: false },
      three: {
        url: 'http://remote.example/sse',
        transportType: 'sse',
        outputTransport: 'ws',
      },
    },
  },
  'servers combined': {
    mcpServers: {
      all: {
        outputTransport: 'sse',
        toolPrefix: 'all_',
        mcpServers: {
          local: { command: 'node', args: ['x.js'], toolPrefix: 'l_' },
          shell: { stdio: 'sh-server', tools: ['run'], description: 'x' },
          far: {
            url: 'https://remote.example/mcp',
            type: 'streamable-http',
            headers: { authorization: 'Bearer x' },
            oauth2Bearer: 'tok',
          },
        },
      },
    },
  },
}

for (const [name, config] of Object.entries(valid))
  test(`the schema takes what the loader takes: ${name}`, () => {
    assert.equal(loads(config), true, 'the loader takes it')
    assert.deepEqual(problems(shipped, config, shipped), [])
  })

// Mistakes an editor should underline, and the loader refuses.
const server = { command: 'x' }
const invalid: [string, unknown, string][] = [
  ['no servers', { port: 1 }, '$: lacks mcpServers'],
  ['an unknown key', { mcpServers: {}, prot: 1 }, '$.prot: unknown key'],
  [
    'a mistyped server key',
    { mcpServers: { a: { comand: 'x' } } },
    '$.mcpServers.a.comand: unknown key',
  ],
  [
    'a port as text',
    { port: '8000', mcpServers: { a: server } },
    '$.port: not integer',
  ],
  [
    'a negative port',
    { port: -1, mcpServers: { a: server } },
    '$.port: below 0',
  ],
  [
    'an unknown output',
    { mcpServers: { a: { ...server, outputTransport: 'http' } } },
    '$.mcpServers.a.outputTransport: not in enum',
  ],
  [
    'an empty command',
    { mcpServers: { a: { command: ' ' } } },
    '$.mcpServers.a.command: does not match \\S',
  ],
  [
    'args that are not a list',
    { mcpServers: { a: { command: 'x', args: 'y' } } },
    '$.mcpServers.a.args: not array',
  ],
  [
    'a header that is not text',
    { mcpServers: { a: { ...server, headers: { n: 1 } } } },
    '$.mcpServers.a.headers.n: not string',
  ],
  [
    'cors as text',
    { mcpServers: { a: { ...server, cors: 'yes' } } },
    '$.mcpServers.a.cors: matches 0 of oneOf',
  ],
  [
    'a url that is no http(s) URL',
    { mcpServers: { a: { url: 'ftp://x', type: 'http' } } },
    '$.mcpServers.a.url: does not match ^https?://',
  ],
  [
    'a URL setting on a combined server',
    { mcpServers: { a: { mcpServers: { b: { ...server, cors: true } } } } },
    '$.mcpServers.a.mcpServers.b.cors: unknown key',
  ],
  [
    'combining two levels deep',
    { mcpServers: { a: { mcpServers: { b: { mcpServers: {} } } } } },
    '$.mcpServers.a.mcpServers.b.mcpServers: unknown key',
  ],
  [
    'a server that is no object',
    { mcpServers: { a: 'x' } },
    '$.mcpServers.a: not object',
  ],
]

for (const [name, config, problem] of invalid)
  test(`the schema refuses what the loader refuses: ${name}`, () => {
    assert.equal(loads(config), false, 'the loader refuses it')
    assert.deepEqual(problems(shipped, config, shipped), [problem])
  })

test('a key the loader takes with no definition fails the generation', async () => {
  const { configSchema } = await generator()
  CONFIG_KEYS.entry.push('brandNew')
  try {
    assert.throws(() => configSchema(), {
      message: 'config.schema.json has no definition for "brandNew"',
    })
  } finally {
    CONFIG_KEYS.entry.pop()
  }
})
