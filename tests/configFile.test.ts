import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveTransport,
  loadConfig,
  type Config,
  type Entry,
} from '../src/config/configFile.js'

// The `--config` file, read and checked without running anything: every rule
// the loader enforces, with the exact message a user sees, including where in
// the file it points.

const FILE = 'servers.json'

const load = (text: string, env: Record<string, string | undefined> = {}) =>
  loadConfig(FILE, text, env)

const configOf = (
  text: string,
  env: Record<string, string | undefined> = {},
): Config => {
  const loaded = load(text, env)
  assert.ok(
    'config' in loaded,
    `expected a valid config, got ${JSON.stringify(loaded)}`,
  )
  return loaded.config
}

const errorOf = (
  text: string,
  env: Record<string, string | undefined> = {},
): string => {
  const loaded = load(text, env)
  assert.ok(
    'error' in loaded,
    `expected an error, got ${JSON.stringify(loaded)}`,
  )
  return loaded.error
}

// A file with these servers and top-level keys, one key per line.
const file = (servers: unknown, top: Record<string, unknown> = {}) =>
  JSON.stringify({ ...top, mcpServers: servers }, null, 2)

// Where `needle` first (or last) appears in `text`, as `file:line:column`,
// 1-based.
const at = (text: string, needle: string, last = false) => {
  const offset = last ? text.lastIndexOf(needle) : text.indexOf(needle)
  assert.notEqual(offset, -1, `${needle} appears in the file`)
  const lines = text.slice(0, offset).split('\n')
  return `${FILE}:${lines.length}:${lines[lines.length - 1].length + 1}`
}

const local = { command: 'node', args: ['server.js'] }
const remote = { url: 'https://example.com/mcp', type: 'streamableHttp' }

const entryOf = (text: string, name = 'a') => {
  const entry = configOf(text).entries.find((e) => e.name === name)
  assert.ok(entry, `entry ${name} is loaded`)
  return entry
}

// --- Reading the file ---

test('a JSON syntax error names the file, line and column', () => {
  const text = '{\n  "mcpServers": {\n    "a" {}\n  }\n}\n'
  assert.equal(errorOf(text), 'Error: servers.json:3:9: colon expected')
})

test('a file nested deeper than it can be read is an error, not a crash', () => {
  const error = {
    error: 'Error: Maximum call stack size exceeded',
    warnings: [],
  }
  // Far beyond any stack: the parser itself runs out.
  assert.deepEqual(load(`${'['.repeat(200000)}${']'.repeat(200000)}`), error)
  // A value nested deep inside an otherwise valid file.
  assert.deepEqual(
    load(
      `{"mcpServers": {"a": {"command": "x", "env": ${'['.repeat(20000)}${']'.repeat(20000)}}}}`,
    ),
    error,
  )
})

test('an empty file is a "value expected" error at its end', () => {
  assert.equal(errorOf(''), 'Error: servers.json:1:1: value expected')
  assert.equal(
    errorOf('// nothing yet\n'),
    'Error: servers.json:2:1: value expected',
  )
})

test('comments and trailing commas are accepted (JSONC)', () => {
  const text = `{
  // the servers
  "mcpServers": {
    /* one */ "a": { "command": "node", "args": ["x.js",], },
  },
}`
  assert.deepEqual(configOf(text), {
    gateway: {},
    defaults: {},
    entries: [
      {
        name: 'a',
        path: '/a',
        server: {
          source: { kind: 'command', command: 'node', args: ['x.js'] },
        },
      },
    ],
  })
})

test('a root that is not an object is refused at the start of the file', () => {
  for (const text of ['[]', 'null', '"mcpServers"', '1'])
    assert.equal(
      errorOf(text),
      'Error: servers.json:1:1: The file must hold an object with "mcpServers"',
    )
})

test('a file without "mcpServers", or with none in it, is refused', () => {
  for (const text of ['{}', '{"port": 8000}'])
    assert.equal(
      errorOf(text),
      'Error: servers.json:1:1: Add "mcpServers" with at least one server',
    )
  assert.equal(
    errorOf('{"mcpServers": {}}'),
    'Error: servers.json:1:2: mcpServers: There is no enabled server to serve',
  )
})

test('"mcpServers" and each entry must be objects', () => {
  for (const servers of [[], null, 'a']) {
    const text = file(servers)
    assert.equal(
      errorOf(text),
      `Error: ${at(text, '"mcpServers"')}: mcpServers: Expected an object`,
    )
  }
  const text = file({ a: ['node'] })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"a"')}: mcpServers.a: Expected an object`,
  )
})

test('a valid file reads into gateway settings, defaults and entries', () => {
  const text = file(
    { tools: local, docs: { ...remote, outputTransport: 'sse' } },
    {
      $schema: 'https://example.com/schema.json',
      port: 9000,
      host: '127.0.0.1',
      logLevel: 'debug',
      logFormat: 'json',
      exitWithProcess: 1234,
      healthEndpoint: '/healthz',
      cors: true,
    },
  )
  assert.deepEqual(configOf(text), {
    gateway: {
      port: 9000,
      host: '127.0.0.1',
      logLevel: 'debug',
      logFormat: 'json',
      exitWithProcess: 1234,
      healthEndpoint: ['/healthz'],
    },
    defaults: { cors: true },
    entries: [
      {
        name: 'tools',
        path: '/tools',
        server: {
          source: { kind: 'command', command: 'node', args: ['server.js'] },
        },
      },
      {
        name: 'docs',
        path: '/docs',
        outputTransport: 'sse',
        server: {
          source: {
            kind: 'url',
            url: 'https://example.com/mcp',
            type: 'streamableHttp',
          },
        },
      },
    ],
  })
})

// --- Keys ---

test('an unknown key is an error, with the nearest known key as a hint', () => {
  const text = file({ a: local }, { prot: 8000 })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"prot"')}: prot: Unknown key "prot". Did you mean "port"?`,
  )
  // Case is ignored when looking for the nearest key.
  const upper = file({ a: local }, { PORT: 8000 })
  assert.equal(
    errorOf(upper),
    `Error: ${at(upper, '"PORT"')}: PORT: Unknown key "PORT". Did you mean "port"?`,
  )
})

test('an unknown key nothing resembles has no hint', () => {
  const text = file({ a: { ...local, zzzzzz: 1 } })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"zzzzzz"')}: mcpServers.a.zzzzzz: Unknown key "zzzzzz".`,
  )
})

test('the hint allows two edits, or one per four characters of a long key', () => {
  const hint = (key: string) => {
    const text = file({ a: { ...local, [key]: 1 } })
    return errorOf(text).split(': ').slice(3).join(': ')
  }
  // Two edits away from "args" (a swap), on a short key: hinted.
  assert.equal(hint('agrs'), 'Unknown key "agrs". Did you mean "args"?')
  // Three edits away from "sessionTimeout", on an 11-character key: the
  // allowance is still two, so no hint.
  assert.equal(hint('sessionTime'), 'Unknown key "sessionTime".')
  // Three edits away from "protocolVersion", on a 12-character key: the
  // allowance is three, so hinted.
  assert.equal(
    hint('protocolVers'),
    'Unknown key "protocolVers". Did you mean "protocolVersion"?',
  )
  // Four edits away from "streamableHttpPath", on a 14-character key: the
  // allowance is three, so no hint.
  assert.equal(hint('streamableHttp'), 'Unknown key "streamableHttp".')
})

test('a key that is not an identifier is quoted in the key path', () => {
  const text = file({ 'my-server': { ...local, 'x-y': 1 } }, {})
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"x-y"')}: mcpServers."my-server"."x-y": Unknown key "x-y".`,
  )
  const top = file({ a: local }, { 'x-y': 1 })
  assert.equal(
    errorOf(top),
    `Error: ${at(top, '"x-y"')}: "x-y": Unknown key "x-y".`,
  )
})

test('keys only client apps use are warned about and ignored', () => {
  const loaded = load(
    file(
      {
        a: { ...local, autoApprove: ['add'], timeout: 60 },
        b: {
          mcpServers: {
            inner: { ...remote, alwaysAllow: [], disabledTools: [] },
          },
          outputTransport: 'sse',
        },
      },
      { description: 'mine', globalShortcut: 'Cmd+K' },
    ),
  )
  assert.deepEqual(loaded.warnings, [
    'Ignored description: it is a setting for the client app, not the gateway',
    'Ignored globalShortcut: it is a setting for the client app, not the gateway',
    'Ignored mcpServers.a.autoApprove: it is a setting for the client app, not the gateway',
    'Ignored mcpServers.a.timeout: it is a setting for the client app, not the gateway',
    'Ignored mcpServers.b.mcpServers.inner.alwaysAllow: it is a setting for the client app, not the gateway',
    'Ignored mcpServers.b.mcpServers.inner.disabledTools: it is a setting for the client app, not the gateway',
  ])
  assert.ok('config' in loaded)
  assert.deepEqual(loaded.config.gateway, {})
  assert.deepEqual(loaded.config.entries[0].server, {
    source: { kind: 'command', command: 'node', args: ['server.js'] },
  })
})

test('every client-only key is recognised', () => {
  const keys = [
    'autoApprove',
    'alwaysAllow',
    'timeout',
    'trust',
    'alwaysLoad',
    'disabledTools',
    'includeTools',
    'excludeTools',
    'envFile',
    'headersHelper',
    'oauth',
    'description',
    'globalShortcut',
  ]
  const loaded = load(
    file({ a: { ...local, ...Object.fromEntries(keys.map((k) => [k, 1])) } }),
  )
  assert.deepEqual(
    loaded.warnings,
    keys.map(
      (key) =>
        `Ignored mcpServers.a.${key}: it is a setting for the client app, not the gateway`,
    ),
  )
  assert.ok('config' in loaded)
})

test('warnings collected before an error are still returned', () => {
  const loaded = load(file({ a: { autoApprove: [] } }))
  assert.deepEqual(loaded, {
    error: `Error: ${at(file({ a: { autoApprove: [] } }), '"a"')}: mcpServers.a: Says nothing to run. Add "command" (with "args"), "stdio", or "url"`,
    warnings: [
      'Ignored mcpServers.a.autoApprove: it is a setting for the client app, not the gateway',
    ],
  })
})

// --- Gateway settings ---

const topError = (key: string, value: unknown, message: string) => {
  const text = file({ a: local }, { [key]: value })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, `"${key}"`)}: ${key}: ${message}`,
    `${key}: ${JSON.stringify(value)}`,
  )
}

test('"port" is a whole number of at least 0', () => {
  assert.equal(configOf(file({ a: local }, { port: 0 })).gateway.port, 0)
  // Each condition on its own: not a number, not whole, below the minimum.
  topError('port', '8000', 'Expected a whole number of at least 0')
  topError('port', 80.5, 'Expected a whole number of at least 0')
  topError('port', -1, 'Expected a whole number of at least 0')
})

test('"exitWithProcess" is a whole number of at least 2', () => {
  assert.equal(
    configOf(file({ a: local }, { exitWithProcess: 2 })).gateway
      .exitWithProcess,
    2,
  )
  topError('exitWithProcess', 1, 'Expected a whole number of at least 2')
})

test('"host" is a non-empty string', () => {
  topError('host', '', 'Expected a non-empty string')
  topError('host', '   ', 'Expected a non-empty string')
  topError('host', 127, 'Expected a non-empty string')
})

test('"logLevel" and "logFormat" are one of their choices', () => {
  assert.equal(
    configOf(file({ a: local }, { logLevel: 'none' })).gateway.logLevel,
    'none',
  )
  topError('logLevel', 'verbose', 'Expected one of "debug", "info", "none"')
  topError('logLevel', 1, 'Expected one of "debug", "info", "none"')
  topError('logFormat', 'xml', 'Expected one of "text", "json"')
})

test('"healthEndpoint" is a path or a list of paths, normalised', () => {
  const single = configOf(file({ a: local }, { healthEndpoint: 'healthz/' }))
  assert.deepEqual(single.gateway.healthEndpoint, ['/healthz'])
  assert.deepEqual(single.defaults, {}, 'top-level health is the gateway own')
  const list = configOf(
    file({ a: local }, { healthEndpoint: ['/healthz', 'ready'] }),
  )
  assert.deepEqual(list.gateway.healthEndpoint, ['/healthz', '/ready'])
  topError('healthEndpoint', '/a b', '"/a b" is not a usable path')
  topError('healthEndpoint', ['/a', 5], 'Expected a list of strings')
  topError('healthEndpoint', {}, 'Expected a list of strings')
  // A bad item in a list is pointed at, by index.
  const text = file({ a: local }, { healthEndpoint: ['/a', '/b?x'] })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"/b?x"')}: healthEndpoint[1]: "/b?x" is not a usable path`,
  )
})

// --- Settings for an entry's URL ---

const entryError = (
  entry: Record<string, unknown>,
  key: string,
  message: string,
  needle = `"${key}"`,
) => {
  const text = file({ a: entry })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, needle)}: mcpServers.a.${key}: ${message}`,
    JSON.stringify(entry),
  )
}

test('"outputTransport" is one of the four transports', () => {
  for (const transport of ['stdio', 'sse', 'ws', 'streamableHttp'])
    assert.equal(
      entryOf(file({ a: { ...remote, outputTransport: transport } }))
        .outputTransport,
      transport,
    )
  entryError(
    { ...local, outputTransport: 'http' },
    'outputTransport',
    'Expected one of "stdio", "sse", "ws", "streamableHttp"',
  )
})

test('the route paths are normalised like the command line', () => {
  const entry = entryOf(
    file({
      a: {
        ...local,
        ssePath: 'events',
        messagePath: '/messages/',
        streamableHttpPath: '/rpc',
      },
    }),
  )
  assert.equal(entry.ssePath, '/events')
  assert.equal(entry.messagePath, '/messages')
  assert.equal(entry.streamableHttpPath, '/rpc')
  entryError(
    { ...local, messagePath: '/a#b' },
    'messagePath',
    '"/a#b" is not a usable path',
  )
})

test('"cors" is true, false, or a list of origins', () => {
  assert.equal(entryOf(file({ a: { ...local, cors: true } })).cors, true)
  assert.equal(
    'cors' in entryOf(file({ a: { ...local, cors: false } })),
    false,
    'false is the same as leaving it out',
  )
  assert.deepEqual(
    entryOf(file({ a: { ...local, cors: ['https://a.example', '/b$/'] } }))
      .cors,
    ['https://a.example', '/b$/'],
  )
  for (const cors of ['*', [''], [1]])
    entryError(
      { ...local, cors },
      'cors',
      'Expected true, false, or a list of origins',
    )
})

test('"apiKey" is a key or a list of keys', () => {
  assert.deepEqual(entryOf(file({ a: { ...local, apiKey: 'k1' } })).apiKey, [
    'k1',
  ])
  assert.deepEqual(
    entryOf(file({ a: { ...local, apiKey: ['k1', 'k2'] } })).apiKey,
    ['k1', 'k2'],
  )
  for (const apiKey of [5, ['k1', ' '], { k: 1 }])
    entryError(
      { ...local, apiKey },
      'apiKey',
      'Expected a key or a list of keys',
    )
  // An empty key would lock nothing: refused here, not only at start-up.
  for (const apiKey of ['', '   '])
    entryError({ ...local, apiKey }, 'apiKey', 'Expected a non-empty string')
})

test('the other URL settings are read with their types checked', () => {
  const entry = entryOf(
    file({
      a: {
        ...local,
        baseUrl: 'https://public.example',
        healthEndpoint: ['live'],
        apiKeyFile: '/run/keys',
        stateful: true,
        sessionTimeout: 1,
        protocolVersion: '2025-03-26',
        headers: { 'x-team': 'core' },
        oauth2Bearer: 'token',
      },
    }),
  )
  assert.deepEqual(
    { ...entry, server: undefined },
    {
      name: 'a',
      path: '/a',
      baseUrl: 'https://public.example',
      healthEndpoint: ['/live'],
      apiKeyFile: '/run/keys',
      stateful: true,
      sessionTimeout: 1,
      protocolVersion: '2025-03-26',
      headers: { 'x-team': 'core' },
      oauth2Bearer: 'token',
      server: undefined,
    },
  )
  entryError(
    { ...local, stateful: 'yes' },
    'stateful',
    'Expected true or false',
  )
  entryError(
    { ...local, sessionTimeout: 0 },
    'sessionTimeout',
    'Expected a whole number of at least 1',
  )
  entryError(
    { ...local, baseUrl: '' },
    'baseUrl',
    'Expected a non-empty string',
  )
  entryError({ ...local, headers: [] }, 'headers', 'Expected an object')
  entryError(
    { ...local, headers: { 'x-n': 1 } },
    'headers."x-n"',
    'Expected a string value',
    '"x-n"',
  )
})

test('top-level URL settings are defaults, kept apart from each entry', () => {
  const config = configOf(
    file(
      { a: { ...local, cors: ['https://a.example'] }, b: local },
      { cors: true, stateful: true, outputTransport: 'streamableHttp' },
    ),
  )
  assert.deepEqual(config.defaults, {
    cors: true,
    stateful: true,
    outputTransport: 'streamableHttp',
  })
  assert.deepEqual(config.entries[0].cors, ['https://a.example'])
  assert.equal(config.entries[1].cors, undefined)
  const text = file({ a: local }, { stateful: 1 })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"stateful"')}: stateful: Expected true or false`,
  )
})

// --- What an entry runs ---

test('"command" with "args" runs without a shell; "args" may be left out', () => {
  assert.deepEqual(
    entryOf(file({ a: { command: 'npx', args: ['-y', 'a b'] } })).server,
    { source: { kind: 'command', command: 'npx', args: ['-y', 'a b'] } },
  )
  assert.deepEqual(entryOf(file({ a: { command: 'server' } })).server, {
    source: { kind: 'command', command: 'server', args: [] },
  })
  entryError(
    { command: 'npx', args: 'x' },
    'args',
    'Expected a list of strings',
  )
  entryError({ command: '' }, 'command', 'Expected a non-empty string')
})

test('"args" may hold empty strings; other lists may not', () => {
  // "" is a real argument, as in `--prefix ""`, and other clients pass it on.
  assert.deepEqual(
    entryOf(file({ a: { command: 'npx', args: ['-y', ''] } })).server,
    { source: { kind: 'command', command: 'npx', args: ['-y', ''] } },
  )
  entryError(
    { command: 'npx', args: ['-y', 1] },
    'args',
    'Expected a list of strings',
  )
  entryError(
    { ...local, cors: ['https://a.example', ''] },
    'cors',
    'Expected true, false, or a list of origins',
  )
  entryError(
    { ...local, healthEndpoint: ['/live', ''] },
    'healthEndpoint',
    'Expected a list of strings',
  )
  entryError(
    { ...local, healthEndpoint: '' },
    'healthEndpoint',
    'Expected a non-empty string',
  )
})

test('"stdio" is one shell command line, without "args"', () => {
  assert.deepEqual(entryOf(file({ a: { stdio: 'npx -y pkg' } })).server, {
    source: { kind: 'stdio', stdio: 'npx -y pkg' },
  })
  entryError(
    { stdio: 'npx', args: ['-y'] },
    'args',
    '"args" goes with "command". "stdio" is one shell command line',
  )
})

test('an entry runs exactly one server', () => {
  entryError(
    { command: 'a', stdio: 'b' },
    'stdio',
    'Has both "command" and "stdio". An entry runs one server (command, stdio or url) or combines several (its own "mcpServers")',
  )
  entryError(
    { stdio: 'b', ...remote },
    'url',
    'Has both "stdio" and "url". An entry runs one server (command, stdio or url) or combines several (its own "mcpServers")',
  )
  const text = file({ a: { env: { A: '1' } } })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"a"')}: mcpServers.a: Says nothing to run. Add "command" (with "args"), "stdio", or "url"`,
  )
})

test('a local server may say "type": "stdio", and nothing else', () => {
  assert.deepEqual(entryOf(file({ a: { ...local, type: 'stdio' } })).server, {
    source: { kind: 'command', command: 'node', args: ['server.js'] },
  })
  entryError(
    { ...local, type: 'sse' },
    'type',
    '"type": "sse" goes with "url". A local server is "type": "stdio", or no type',
  )
})

test('"env" and "cwd" go to a local server', () => {
  assert.deepEqual(
    entryOf(file({ a: { stdio: 'x', env: { A: '1' }, cwd: '/srv' } })).server,
    { source: { kind: 'stdio', stdio: 'x' }, env: { A: '1' }, cwd: '/srv' },
  )
  entryError(
    { ...local, env: { A: true } },
    'env.A',
    'Expected a string value',
    '"A"',
  )
  entryError({ ...local, cwd: 3 }, 'cwd', 'Expected a non-empty string')
  assert.deepEqual(entryOf(file({ a: { ...local, env: {} } })).server, {
    source: { kind: 'command', command: 'node', args: ['server.js'] },
    env: {},
  })
})

test('every spelling of a remote transport is understood', () => {
  const spellings: [string, string][] = [
    ['sse', 'sse'],
    ['http', 'streamableHttp'],
    ['streamable-http', 'streamableHttp'],
    ['streamableHttp', 'streamableHttp'],
    ['streamable_http', 'streamableHttp'],
  ]
  for (const [type, kind] of spellings)
    assert.deepEqual(
      entryOf(file({ a: { url: 'http://h/mcp', type } })).server,
      { source: { kind: 'url', url: 'http://h/mcp', type: kind } },
      type,
    )
})

test('"transportType" is accepted for "type"', () => {
  assert.deepEqual(
    entryOf(file({ a: { url: 'http://h/sse', transportType: 'sse' } })).server,
    { source: { kind: 'url', url: 'http://h/sse', type: 'sse' } },
  )
  entryError(
    { url: 'http://h/sse', transportType: 'websocket' },
    'transportType',
    '"websocket" is not a remote transport. Use "streamableHttp" or "sse"',
  )
})

test('"type" and "transportType" together are an error', () => {
  entryError(
    { url: 'http://h/sse', type: 'sse', transportType: 'sse' },
    'transportType',
    'Has both "type" and "transportType", which mean the same. Keep "type"',
  )
})

test('a remote server needs a known "type"', () => {
  entryError(
    { url: 'http://h/mcp' },
    'url',
    'Add "type": "streamableHttp" or "sse", so it is clear how to reach this server',
  )
  entryError(
    { url: 'http://h/mcp', type: 'ws' },
    'type',
    '"ws" is not a remote transport. Use "streamableHttp" or "sse"',
  )
  entryError(
    { url: 'http://h/mcp', type: 7 },
    'type',
    'Expected a non-empty string',
  )
})

test('"url" is an http or https URL', () => {
  assert.deepEqual(
    entryOf(file({ a: { ...remote, url: 'http://127.0.0.1:9/mcp' } })).server,
    {
      source: {
        kind: 'url',
        url: 'http://127.0.0.1:9/mcp',
        type: 'streamableHttp',
      },
    },
  )
  entryError(
    { ...remote, url: 'ftp://h/mcp' },
    'url',
    '"ftp://h/mcp" is not an http(s) URL',
  )
  entryError(
    { ...remote, url: 'not a url' },
    'url',
    '"not a url" is not an http(s) URL',
  )
})

test('"args", "env" and "cwd" do not go with "url"', () => {
  for (const [key, value] of [
    ['args', ['x']],
    ['env', { A: '1' }],
    ['cwd', '/srv'],
  ] as const)
    entryError(
      { ...remote, [key]: value },
      key,
      `"${key}" goes with a local server ("command" or "stdio"), not "url"`,
    )
})

test('an entry\'s "headers" and "oauth2Bearer" are URL settings, local or remote', () => {
  for (const server of [local, remote]) {
    const entry = entryOf(
      file({ a: { ...server, headers: { 'x-a': '1' }, oauth2Bearer: 't' } }),
    )
    assert.deepEqual(entry.headers, { 'x-a': '1' })
    assert.equal(entry.oauth2Bearer, 't')
    assert.equal('headers' in entry.server, false)
    assert.equal('oauth2Bearer' in entry.server, false)
  }
})

// --- Where an entry is served ---

test('an entry is served at /<name>, or at its "path", normalised', () => {
  const paths: [unknown, string][] = [
    ['tools', '/tools'],
    ['/tools/', '/tools'],
    ['/a/b', '/a/b'],
    ['/', '/'],
    ['//', '/'],
  ]
  for (const [path, expected] of paths)
    assert.equal(entryOf(file({ a: { ...local, path } })).path, expected)
  assert.equal(
    entryOf(file({ 'my_server-2': local }), 'my_server-2').path,
    '/my_server-2',
  )
})

test('a "path" with "//", "?", "#" or whitespace is refused', () => {
  for (const path of ['/a//b', '/a?x=1', '/a#top', '/a b', '/a\tb'])
    entryError({ ...local, path }, 'path', `"${path}" is not a usable path`)
  entryError({ ...local, path: '' }, 'path', 'Expected a non-empty string')
})

test('a name a URL cannot carry needs a "path", with a suggestion', () => {
  const suggestions: [string, string][] = [
    ['My Server!', '/my-server'],
    ['(beta)', '/beta'],
    ['!!!', '/server'],
  ]
  for (const [name, path] of suggestions) {
    const text = file({ [name]: local })
    assert.equal(
      errorOf(text),
      `Error: ${at(text, JSON.stringify(name))}: mcpServers."${name}": "${name}" can't be used in a URL. Add "path", e.g. "path": "${path}"`,
    )
  }
  assert.equal(
    entryOf(file({ 'My Server!': { ...local, path: '/mine' } }), 'My Server!')
      .path,
    '/mine',
  )
})

test('two entries cannot share a path', () => {
  const text = file({
    x: { ...local, outputTransport: 'sse' },
    a: { ...local, path: '/x/' },
  })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"a"')}: mcpServers.a: mcpServers.a and mcpServers.x both use the path /x`,
  )
})

// --- Turning entries off ---

test('"disabled" and "enabled" turn an entry off', () => {
  const config = configOf(
    file({
      on: local,
      off: { ...local, disabled: true },
      alsoOff: { ...local, enabled: false },
      explicit: { ...local, enabled: true, disabled: false },
      bothSaid: { ...local, enabled: true, disabled: true },
      // Nothing else in a disabled entry is checked but its keys.
      broken: { disabled: true },
    }),
  )
  assert.deepEqual(
    config.entries.map((e) => e.name),
    ['on', 'explicit'],
  )
  entryError(
    { ...local, disabled: 'yes' },
    'disabled',
    'Expected true or false',
  )
  entryError({ ...local, enabled: 0 }, 'enabled', 'Expected true or false')
})

test('a file with every entry disabled has nothing to serve', () => {
  const text = file({ a: { ...local, disabled: true } })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"mcpServers"')}: mcpServers: There is no enabled server to serve`,
  )
})

// --- stdio output ---

test('stdio output carries one entry at most', () => {
  const text = file({ a: remote, b: remote })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"b"')}: mcpServers.b: mcpServers.a and mcpServers.b would both use stdio output, which carries one entry. Combine them under one entry's "mcpServers", or set "outputTransport" on one`,
  )
  // Counted with the file's default output, too.
  const byDefault = file(
    {
      a: remote,
      b: { ...local, outputTransport: 'sse' },
      c: { mcpServers: { d: remote } },
    },
    { outputTransport: 'stdio' },
  )
  assert.equal(
    errorOf(byDefault),
    `Error: ${at(byDefault, '"c"')}: mcpServers.c: mcpServers.a and mcpServers.c would both use stdio output, which carries one entry. Combine them under one entry's "mcpServers", or set "outputTransport" on one`,
  )
  assert.equal(
    configOf(file({ a: remote, b: { ...remote, outputTransport: 'sse' } }))
      .entries.length,
    2,
  )
})

test('a local server is not served over stdio', () => {
  const message =
    'A local server already speaks stdio. Serve it with "outputTransport": "sse", "ws" or "streamableHttp"'
  for (const server of [local, { stdio: 'srv' }]) {
    const text = file({ a: { ...server, outputTransport: 'stdio' } })
    assert.equal(
      errorOf(text),
      `Error: ${at(text, '"a"')}: mcpServers.a: ${message}`,
    )
  }
  // From the file's default, too.
  const byDefault = file({ a: remote, b: local }, { outputTransport: 'stdio' })
  assert.equal(
    errorOf(byDefault),
    `Error: ${at(byDefault, '"b"')}: mcpServers.b: ${message}`,
  )
  // An entry's own output wins over that default.
  assert.equal(
    entryOf(
      file(
        { a: { ...local, outputTransport: 'sse' } },
        { outputTransport: 'stdio' },
      ),
    ).outputTransport,
    'sse',
  )
  // A remote server bridged to stdio is what stdio output is for.
  assert.equal(
    entryOf(file({ a: { ...remote, outputTransport: 'stdio' } }))
      .outputTransport,
    'stdio',
  )
  // Local servers combined on stdio are not this rule's to refuse.
  const combined = entryOf(
    file({
      a: {
        outputTransport: 'stdio',
        mcpServers: { b: local, c: { stdio: 'srv' } },
      },
    }),
  )
  assert.equal(effectiveTransport(combined, {}), 'stdio')
})

// --- Combining servers on one URL ---

test('an entry with its own "mcpServers" combines them', () => {
  const entry = entryOf(
    file({
      a: {
        path: '/all',
        cors: true,
        enabled: true,
        disabled: false,
        mcpServers: {
          files: { command: 'fs', env: { ROOT: '/' }, cwd: '/tmp' },
          shell: { stdio: 'sh-server' },
          docs: {
            ...remote,
            headers: { authorization: 'Bearer x' },
            oauth2Bearer: 'tok',
          },
          plain: { url: 'http://h/sse', type: 'sse' },
          off: { command: 'x', disabled: true },
        },
      },
    }),
  )
  assert.deepEqual(entry, {
    name: 'a',
    path: '/all',
    cors: true,
    server: {
      members: [
        {
          name: 'files',
          source: { kind: 'command', command: 'fs', args: [] },
          env: { ROOT: '/' },
          cwd: '/tmp',
        },
        { name: 'shell', source: { kind: 'stdio', stdio: 'sh-server' } },
        {
          name: 'docs',
          source: {
            kind: 'url',
            url: 'https://example.com/mcp',
            type: 'streamableHttp',
          },
          headers: { authorization: 'Bearer x' },
          oauth2Bearer: 'tok',
        },
        {
          name: 'plain',
          source: { kind: 'url', url: 'http://h/sse', type: 'sse' },
        },
      ],
    },
  })
})

test('an entry either runs a server or combines several', () => {
  for (const key of ['command', 'stdio', 'url', 'env', 'cwd'])
    entryError(
      { [key]: key === 'env' ? {} : 'x', mcpServers: { b: local } },
      key,
      `An entry with its own "mcpServers" combines them; "${key}" belongs on one of those servers`,
    )
  const text = file({ a: { mcpServers: [] } })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"mcpServers"', true)}: mcpServers.a.mcpServers: Expected an object`,
  )
})

test('combining goes one level deep', () => {
  const text = file({ a: { mcpServers: { b: { mcpServers: { c: local } } } } })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"mcpServers"', true)}: mcpServers.a.mcpServers.b.mcpServers: Combining goes one level deep only; a combined server cannot combine others`,
  )
})

test('a combined server takes no URL settings, and no "path"', () => {
  const text = file({ a: { mcpServers: { b: { ...local, cors: true } } } })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"cors"')}: mcpServers.a.mcpServers.b.cors: "cors" is a setting for the URL. Put it on mcpServers.a instead`,
  )
  const pathText = file({ a: { mcpServers: { b: { ...local, path: '/b' } } } })
  assert.equal(
    errorOf(pathText),
    `Error: ${at(pathText, '"path"')}: mcpServers.a.mcpServers.b.path: A combined server is served at mcpServers.a's URL; "path" belongs there`,
  )
})

test("a combined server's unknown keys are errors, its client keys warnings", () => {
  const text = file({ a: { mcpServers: { b: { ...local, evn: {} } } } })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"evn"')}: mcpServers.a.mcpServers.b.evn: Unknown key "evn". Did you mean "env"?`,
  )
})

test('a combined local server sends no "headers" or "oauth2Bearer"', () => {
  for (const [key, value] of [
    ['headers', { 'x-a': '1' }],
    ['oauth2Bearer', 'tok'],
  ] as const) {
    for (const server of [local, { stdio: 'x' }]) {
      const text = file({
        a: { mcpServers: { b: { ...server, [key]: value } } },
      })
      assert.equal(
        errorOf(text),
        `Error: ${at(text, `"${key}"`)}: mcpServers.a.mcpServers.b.${key}: "${key}" is sent to a remote server, so it goes with "url"`,
      )
    }
  }
  const text = file({
    a: { mcpServers: { b: { ...remote, headers: { 'x-a': 1 } } } },
  })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"x-a"')}: mcpServers.a.mcpServers.b.headers."x-a": Expected a string value`,
  )
})

test('a combined entry with every member disabled has nothing to combine', () => {
  const text = file({
    a: {
      mcpServers: {
        b: { ...local, disabled: true },
        c: { ...remote, enabled: false },
      },
    },
  })
  assert.equal(
    errorOf(text),
    `Error: ${at(text, '"mcpServers"', true)}: mcpServers.a.mcpServers: There is no enabled server to combine`,
  )
})

// --- The output an entry ends up with ---

const entry = (
  server: Entry['server'],
  outputTransport?: Entry['outputTransport'],
): Entry => ({
  name: 'a',
  path: '/a',
  server,
  ...(outputTransport ? { outputTransport } : {}),
})
const command = { source: { kind: 'command' as const, command: 'x', args: [] } }
const url = {
  source: { kind: 'url' as const, url: 'http://h/mcp', type: 'sse' as const },
}

test("effectiveTransport: the entry's own, then the file's, then the CLI default", () => {
  assert.equal(
    effectiveTransport(entry(command, 'ws'), { outputTransport: 'sse' }),
    'ws',
  )
  assert.equal(
    effectiveTransport(entry(command), { outputTransport: 'streamableHttp' }),
    'streamableHttp',
  )
  assert.equal(effectiveTransport(entry(command), {}), 'sse')
  assert.equal(effectiveTransport(entry(url), {}), 'stdio')
  assert.equal(
    effectiveTransport(
      entry({
        members: [
          { name: 'b', ...url },
          { name: 'c', ...url },
        ],
      }),
      {},
    ),
    'stdio',
    'only remote servers combined: bridged to stdio, as one would be',
  )
  assert.equal(
    effectiveTransport(
      entry({
        members: [
          { name: 'b', ...url },
          { name: 'c', ...command },
        ],
      }),
      {},
    ),
    'sse',
    'any local server combined: served over SSE',
  )
})

// --- ${VAR} ---

// A value in a server's `env`, once expanded; `env` values may be empty.
const expanded = (value: string, env: Record<string, string | undefined>) => {
  const config = configOf(file({ a: { command: 'x', env: { V: value } } }), env)
  const server = config.entries[0].server as { env: Record<string, string> }
  return server.env.V
}

test('${VAR}, ${env:VAR} and ${VAR:-default} are expanded in strings', () => {
  const env = { TOKEN: 'abc', EMPTY: '' }
  assert.equal(expanded('--token=${TOKEN}', env), '--token=abc')
  assert.equal(expanded('${env:TOKEN}', env), 'abc')
  assert.equal(expanded('${TOKEN:-other}', env), 'abc')
  assert.equal(expanded('${UNSET:-fallback}', env), 'fallback')
  assert.equal(expanded('${UNSET:-}', env), '')
  assert.equal(expanded('${env:UNSET:-d}', env), 'd')
  // Empty is unset: a secret that did not resolve is not a value.
  assert.equal(expanded('${EMPTY:-fallback}', env), 'fallback')
  assert.equal(expanded('${_A1}-${TOKEN}', { _A1: 'x', TOKEN: 'y' }), 'x-y')
})

test('$$ is a literal $', () => {
  assert.equal(expanded('cost: $$5', {}), 'cost: $5')
  assert.equal(expanded('$${TOKEN}', { TOKEN: 'abc' }), '${TOKEN}')
  assert.equal(expanded('$$$${TOKEN}', { TOKEN: 'abc' }), '$${TOKEN}')
  assert.equal(expanded('$$${TOKEN}', { TOKEN: 'abc' }), '$abc')
  assert.equal(expanded('a $ b', {}), 'a $ b', 'a lone $ is left alone')
})

test('a variable that is not set, or set empty, is an error', () => {
  for (const env of [{}, { TOKEN: '' }]) {
    const text = file({ a: { command: 'x', args: ['-v', '${TOKEN}'] } })
    assert.equal(
      errorOf(text, env),
      `Error: ${at(text, '"${TOKEN}"')}: mcpServers.a.args[1]: \${TOKEN} is not set. Set it, or give a default: \${TOKEN:-…}`,
    )
  }
})

test('a malformed ${ is an error, never passed on', () => {
  const malformed: [string, string][] = [
    ['x${TOKEN', '${'],
    ['${1A}', '${1A}'],
    ['${A-B}', '${A-B}'],
    ['${}', '${}'],
    ['${env:}', '${env:}'],
    ['${A:B}', '${'],
  ]
  for (const [value, match] of malformed) {
    const text = file({ a: { ...local, cwd: value } })
    assert.equal(
      errorOf(text, { A: '1', TOKEN: '1' }),
      `Error: ${at(text, '"cwd"')}: mcpServers.a.cwd: "${match}" is not a variable. Write \${NAME} or \${NAME:-default}, and $$ for a literal $`,
      value,
    )
  }
})

test('variables are expanded everywhere a string is, but never in "stdio"', () => {
  const env = { V: 'val', P: '9000', H: 'example.com' }
  const config = configOf(
    file(
      {
        a: {
          stdio: 'server --root ${V} $$HOME',
          env: { A: '${V}', stdio: '${V}' },
          headers: { stdio: '${V}', 'x-v': 'v=${V}' },
          path: '/${V}',
        },
        b: {
          outputTransport: 'sse',
          mcpServers: {
            c: { stdio: 'echo ${V}' },
            d: {
              url: 'https://${H}/mcp',
              type: 'http',
              headers: { k: '${V}' },
            },
          },
        },
      },
      { host: '${env:H}', apiKey: ['${V}'] },
    ),
    env,
  )
  assert.equal(config.gateway.host, 'example.com')
  assert.deepEqual(config.defaults.apiKey, ['val'])
  const [a, b] = config.entries
  assert.deepEqual(a.server, {
    source: { kind: 'stdio', stdio: 'server --root ${V} $$HOME' },
    env: { A: 'val', stdio: 'val' },
  })
  assert.deepEqual(a.headers, { stdio: 'val', 'x-v': 'v=val' })
  assert.equal(a.path, '/val')
  assert.deepEqual(b.server, {
    members: [
      { name: 'c', source: { kind: 'stdio', stdio: 'echo ${V}' } },
      {
        name: 'd',
        source: {
          kind: 'url',
          url: 'https://example.com/mcp',
          type: 'streamableHttp',
        },
        headers: { k: 'val' },
      },
    ],
  })
})

test('values that are not strings pass through expansion untouched', () => {
  const entry = entryOf(
    file({ a: { ...local, stateful: false, sessionTimeout: 5, cors: true } }),
  )
  assert.equal(entry.stateful, false)
  assert.equal(entry.sessionTimeout, 5)
  assert.equal(entry.cors, true)
  // null reaches the type check as null, not as a string or an object.
  entryError({ ...local, cwd: null }, 'cwd', 'Expected a non-empty string')
  entryError({ ...local, env: null }, 'env', 'Expected an object')
})

test('names are never expanded, nor comments', () => {
  const config = configOf(
    `{
  // \${UNSET} in a comment is not read
  "mcpServers": { "a": { "command": "x", "env": { "\${A}": "1" } } }
}`,
  )
  assert.deepEqual(config.entries[0].server, {
    source: { kind: 'command', command: 'x', args: [] },
    env: { '${A}': '1' },
  })
})
