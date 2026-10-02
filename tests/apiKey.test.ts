import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import type { IncomingMessage } from 'node:http'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'
import {
  acceptsApiKey,
  apiKeysOf,
  logApiKeys,
  requireApiKey,
  verifyApiKey,
} from '../src/lib/apiKey.js'

const KEY_ONE = 'sg-test-key-one-6c1f'
const KEY_TWO = 'sg-test-key-two-93ab'
const WRONG = 'sg-test-key-wrong-0d2e'
const UNAUTHORIZED_BODY =
  '{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized: a valid API key is required"},"id":null}'
const BRIDGE_ERROR =
  'Error: --apiKey applies only when supergateway listens (stdio→SSE, stdio→WS or stdio→Streamable HTTP); to send a key to a remote server use --header or --oauth2Bearer'
const VERSION = '2026-07-28'
const options = { timeout: gatewayTimeout(90000) }

type Kind = 'sse' | 'ws' | 'http'
type Mode = { label: string; kind: Kind; args: string[]; path: string }
const modes: Mode[] = [
  {
    label: 'SSE',
    kind: 'sse',
    args: ['--outputTransport', 'sse'],
    path: '/sse',
  },
  {
    label: 'WS',
    kind: 'ws',
    args: ['--outputTransport', 'ws'],
    path: '/message',
  },
  {
    label: 'stateless Streamable HTTP',
    kind: 'http',
    args: ['--outputTransport', 'streamableHttp'],
    path: '/mcp',
  },
  {
    label: 'stateful Streamable HTTP',
    kind: 'http',
    args: ['--outputTransport', 'streamableHttp', '--stateful'],
    path: '/mcp',
  },
]

type Reply = {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

async function start(
  t: TestContext,
  mode: Mode,
  extra: string[] = [],
  env?: Record<string, string>,
) {
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    ['--stdio', peerCommand, '--port', String(port), ...mode.args, ...extra],
    env,
  )
  await gateway.ready()
  return { gateway, port, base: `http://127.0.0.1:${port}` }
}

const replyOf = async (response: Response): Promise<Reply> => ({
  status: response.status,
  headers: Object.fromEntries(response.headers),
  body: await response.text(),
})

async function wsOpen(
  port: number,
  headers: Record<string, string>,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/message`, { headers })
    ws.once('open', () => {
      ws.close()
      resolve({ status: 101, headers: {}, body: '' })
    })
    ws.once('unexpected-response', (_req, res: IncomingMessage) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () =>
        resolve({ status: res.statusCode!, headers: res.headers, body }),
      )
    })
    ws.once('error', reject)
  })
}

/** The request each mode starts with, answered or refused. */
async function open(
  mode: Mode,
  port: number,
  headers: Record<string, string>,
): Promise<Reply> {
  const base = `http://127.0.0.1:${port}`
  if (mode.kind === 'ws') return wsOpen(port, headers)
  if (mode.kind === 'sse') {
    const controller = new AbortController()
    const response = await fetch(`${base}/sse`, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: controller.signal,
    })
    if (response.status !== 200) return replyOf(response)
    controller.abort()
    return {
      status: 200,
      headers: Object.fromEntries(response.headers),
      body: '',
    }
  }
  return replyOf(
    await fetch(`${base}/mcp`, {
      method: 'POST',
      signal: AbortSignal.timeout(requestTimeout(10000)),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initialize(1)),
    }),
  )
}

async function wsSession(port: number, headers: Record<string, string>) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/message`, { headers })
  const pending = new Map<unknown, (message: any) => void>()
  ws.on('message', (data) => {
    const message = JSON.parse(String(data))
    pending.get(message.id)?.(message)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const call = (message: { id: number | string; [key: string]: unknown }) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error(`no reply to ${message.id}`)),
        requestTimeout(10000),
      )
      pending.set(message.id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      ws.send(JSON.stringify(message))
    })
  try {
    await call(initialize(1))
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )
    const list = await call({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {},
    })
    return list.result.tools.map((tool: { name: string }) => tool.name)
  } finally {
    ws.close()
  }
}

/** A full MCP initialize and `tools/list`, as the mode's client does it. */
async function session(
  t: TestContext,
  mode: Mode,
  port: number,
  headers: Record<string, string>,
): Promise<string[]> {
  if (mode.kind === 'ws') return wsSession(port, headers)
  const client = new Client({ name: 'api-key-test', version: '1.0.0' })
  const url = new URL(`http://127.0.0.1:${port}${mode.path}`)
  const transport =
    mode.kind === 'sse'
      ? new SSEClientTransport(url, { requestInit: { headers } })
      : new StreamableHTTPClientTransport(url, { requestInit: { headers } })
  t.after(() => client.close())
  await client.connect(transport, { timeout: requestTimeout(10000) })
  const { tools } = await client.listTools(
    {},
    { timeout: requestTimeout(10000) },
  )
  await client.close()
  return tools.map((tool) => tool.name)
}

function assertUnauthorized(reply: Reply) {
  assert.equal(reply.status, 401)
  assert.equal(reply.headers['www-authenticate'], 'Bearer realm="supergateway"')
  assert.equal(reply.headers['content-type'], 'application/json')
  assert.equal(reply.body, UNAUTHORIZED_BODY)
}

async function modern(port: number, headers: Record<string, string>) {
  return replyOf(
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      signal: AbortSignal.timeout(requestTimeout(10000)),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': VERSION,
        'mcp-method': 'tools/list',
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 17,
        method: 'tools/list',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': VERSION,
            'io.modelcontextprotocol/clientInfo': {
              name: 'api-key-test',
              version: '1',
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    }),
  )
}

const assertNoKeys = (text: string) => {
  for (const key of [KEY_ONE, KEY_TWO, WRONG])
    assert.ok(!text.includes(key), `${key} appeared in the gateway's output`)
}

for (const mode of modes) {
  test(`${mode.label}: --apiKey guards every request`, options, async (t) => {
    const { gateway, port, base } = await start(t, mode, [
      '--apiKey',
      KEY_ONE,
      '--apiKey',
      KEY_TWO,
      '--cors',
      '--healthEndpoint',
      '/healthz',
      '--logLevel',
      'debug',
    ])
    const all = () => gateway.output() + gateway.errors()
    await t.test('the startup listing says a key is required', () => {
      assert.match(
        gateway.output(),
        /^\[supergateway\] {3}- API key: required \(2 keys\)$/m,
      )
    })

    await t.test('no key: 401 with the exact headers and body', async () => {
      assertUnauthorized(await open(mode, port, {}))
      assert.match(
        gateway.output(),
        new RegExp(
          `Rejected a request without a valid API key: ${mode.kind === 'http' ? 'POST' : 'GET'} ${mode.path}$`,
          'm',
        ),
      )
    })

    await t.test('a wrong key: 401, as Bearer and as X-API-Key', async () => {
      assertUnauthorized(
        await open(mode, port, { authorization: `Bearer ${WRONG}` }),
      )
      assertUnauthorized(await open(mode, port, { 'x-api-key': WRONG }))
      // A different scheme is not a bearer token, even with the right key.
      assertUnauthorized(
        await open(mode, port, { authorization: `Basic ${KEY_ONE}` }),
      )
    })

    if (mode.kind === 'ws')
      await t.test('a refused upgrade never becomes a connection', () => {
        assert.doesNotMatch(all(), /New WebSocket connection/)
      })

    await t.test(
      'a correct Bearer key: initialize and tools/list',
      async () => {
        assert.deepEqual(
          await session(t, mode, port, { authorization: `Bearer ${KEY_ONE}` }),
          ['add'],
        )
      },
    )

    await t.test('a correct X-API-Key works', async () => {
      assert.deepEqual(await session(t, mode, port, { 'x-api-key': KEY_ONE }), [
        'add',
      ])
    })

    await t.test('a lowercase bearer scheme works', async () => {
      assert.deepEqual(
        await session(t, mode, port, { authorization: `bearer ${KEY_ONE}` }),
        ['add'],
      )
    })

    await t.test('either of two keys works', async () => {
      assert.deepEqual(
        await session(t, mode, port, { authorization: `Bearer ${KEY_TWO}` }),
        ['add'],
      )
      assert.notEqual(
        (await open(mode, port, { 'x-api-key': KEY_TWO })).status,
        401,
      )
    })

    await t.test('the health endpoint stays open', async () => {
      const response = await fetch(`${base}/healthz`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'ok')
    })

    await t.test('the CORS preflight is answered', async () => {
      const response = await fetch(`${base}${mode.path}`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      })
      assert.equal(response.status, 204)
      assert.equal(response.headers.get('access-control-allow-origin'), '*')
    })

    if (mode.kind === 'sse')
      await t.test('the message endpoint needs a key too', async () => {
        const post = (headers: Record<string, string>) =>
          fetch(`${base}/message?sessionId=none`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(initialize(1)),
          }).then(replyOf)
        assertUnauthorized(await post({}))
        assert.match(
          gateway.output(),
          /Rejected a request without a valid API key: POST \/message$/m,
        )
        // Past the check, the gateway's own answer for an unknown session.
        assert.equal((await post({ 'x-api-key': KEY_ONE })).status, 503)
      })

    if (mode.kind === 'ws')
      await t.test('a plain HTTP request needs a key too', async () => {
        assertUnauthorized(await fetch(`${base}/message`).then(replyOf))
        assert.equal(
          (
            await fetch(`${base}/message`, {
              headers: { 'x-api-key': KEY_ONE },
            })
          ).status,
          404,
        )
      })

    if (mode.kind === 'http') {
      await t.test('GET and DELETE on the path need a key too', async () => {
        for (const method of ['GET', 'DELETE']) {
          assertUnauthorized(
            await fetch(`${base}/mcp`, { method }).then(replyOf),
          )
          assert.match(
            gateway.output(),
            new RegExp(
              `Rejected a request without a valid API key: ${method} /mcp$`,
              'm',
            ),
          )
          // Past the check: 405 stateless, 400 (no session) stateful.
          const passed = await fetch(`${base}/mcp`, {
            method,
            headers: { authorization: `Bearer ${KEY_ONE}` },
          })
          assert.equal(
            passed.status,
            mode.args.includes('--stateful') ? 400 : 405,
          )
        }
      })

      await t.test('a 2026-07-28 request without a key: 401', async () => {
        assertUnauthorized(await modern(port, {}))
        assertUnauthorized(await modern(port, { 'x-api-key': WRONG }))
      })

      await t.test('a 2026-07-28 request with a key is answered', async () => {
        for (const headers of <Record<string, string>[]>[
          { 'x-api-key': KEY_ONE },
          { authorization: `Bearer ${KEY_TWO}` },
        ]) {
          const reply = await modern(port, headers)
          assert.equal(reply.status, 200)
          assert.deepEqual(
            JSON.parse(reply.body).result.tools.map(
              (tool: { name: string }) => tool.name,
            ),
            ['add'],
          )
        }
      })
    }

    await t.test('no key ever appears in stdout or stderr', () => {
      assert.match(all(), /Rejected a request/)
      assertNoKeys(all())
    })
  })

  test(
    `${mode.label}: with no key configured, nothing changes`,
    options,
    async (t) => {
      const { gateway, port } = await start(t, mode)
      assert.deepEqual(await session(t, mode, port, {}), ['add'])
      assert.notEqual((await open(mode, port, {})).status, 401)
      if (mode.kind === 'http')
        assert.equal((await modern(port, {})).status, 200)
      const all = gateway.output() + gateway.errors()
      assert.doesNotMatch(all, /API key/)
    },
  )
}

// The key is checked before the body is read: a caller without one must not
// make the gateway parse up to 4 MB, and learns only that it needs a key.
for (const mode of modes.filter((mode) => mode.kind === 'http')) {
  test(
    `${mode.label}: a request without a key is refused before its body is read`,
    options,
    async (t) => {
      const { base } = await start(t, mode, ['--apiKey', KEY_ONE])
      const post = (headers: Record<string, string>, body: string) =>
        fetch(base + mode.path, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body,
        }).then(replyOf)
      assertUnauthorized(await post({}, '{not json'))
      assertUnauthorized(await post({}, `"${'x'.repeat(5 * 1024 * 1024)}"`))
      // Past the check, a malformed body is still the client's mistake.
      assert.equal(
        (await post({ authorization: `Bearer ${KEY_ONE}` }, '{not json'))
          .status,
        400,
      )
    },
  )
}

const stateless = modes[2]

function keyFile(t: TestContext, content: string) {
  const directory = mkdtempSync(join(tmpdir(), 'api-key-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const path = join(directory, 'keys')
  writeFileSync(path, content)
  return path
}

async function accepted(port: number, key: string) {
  return (await open(stateless, port, { 'x-api-key': key })).status === 200
}

test(
  '--apiKeyFile: one key per line, trimmed, blanks skipped',
  options,
  async (t) => {
    const path = keyFile(t, `\n  ${KEY_ONE}  \n\n\t${KEY_TWO}\r\n`)
    const { gateway, port } = await start(t, stateless, ['--apiKeyFile', path])
    assert.match(gateway.output(), /- API key: required \(2 keys\)$/m)
    assert.ok(await accepted(port, KEY_ONE))
    assert.ok(await accepted(port, KEY_TWO))
    assertUnauthorized(await open(stateless, port, {}))
    assertNoKeys(gateway.output() + gateway.errors())
  },
)

test('SUPERGATEWAY_API_KEY alone requires its key', options, async (t) => {
  const { gateway, port } = await start(t, stateless, [], {
    SUPERGATEWAY_API_KEY: KEY_ONE,
  })
  assert.match(gateway.output(), /- API key: required \(1 key\)$/m)
  assert.ok(await accepted(port, KEY_ONE))
  assertUnauthorized(await open(stateless, port, { 'x-api-key': KEY_TWO }))
  assertNoKeys(gateway.output() + gateway.errors())
})

test(
  'SUPERGATEWAY_API_KEY_FILE alone requires its keys',
  options,
  async (t) => {
    const path = keyFile(t, `${KEY_TWO}\n`)
    const { gateway, port } = await start(t, stateless, [], {
      SUPERGATEWAY_API_KEY_FILE: path,
    })
    assert.match(gateway.output(), /- API key: required \(1 key\)$/m)
    assert.ok(await accepted(port, KEY_TWO))
    assertUnauthorized(await open(stateless, port, { 'x-api-key': KEY_ONE }))
  },
)

test('the accepted keys are the union of every source', options, async (t) => {
  const keys = [
    'sg-union-cli',
    'sg-union-env',
    'sg-union-file',
    'sg-union-envfile',
  ]
  const { gateway, port } = await start(
    t,
    stateless,
    [
      '--apiKey',
      keys[0],
      '--apiKeyFile',
      keyFile(t, `${keys[2]}\n${keys[0]}\n`),
    ],
    {
      SUPERGATEWAY_API_KEY: keys[1],
      SUPERGATEWAY_API_KEY_FILE: keyFile(t, keys[3]),
    },
  )
  // The duplicate is one key.
  assert.match(gateway.output(), /- API key: required \(4 keys\)$/m)
  for (const key of keys) assert.ok(await accepted(port, key), key)
  assertUnauthorized(await open(stateless, port, { 'x-api-key': WRONG }))
})

async function refusal(
  t: TestContext,
  args: string[],
  env?: Record<string, string>,
) {
  const gateway = launchGateway(t, args, env)
  // Bounded, so a gateway that starts instead of refusing fails here.
  const { code } = await Promise.race([
    gateway.exited,
    delay(requestTimeout(15000), { code: 'still running' }),
  ])
  return { code, text: gateway.output() + gateway.errors() }
}

test('startup errors exit 1 with a clear message', options, async (t) => {
  const missing = join(tmpdir(), 'supergateway-no-such-key-file')
  const blank = keyFile(t, '\n   \n\t\n')
  // A port of its own each, so one that wrongly starts cannot fail the next.
  const listening = async () => [
    '--stdio',
    peerCommand,
    '--port',
    String(await unusedPort()),
  ]
  const cases: [string[], Record<string, string> | undefined, RegExp][] = [
    [['--apiKey', ''], undefined, /Error: --apiKey is set but empty/],
    [['--apiKey'], undefined, /Error: --apiKey is set but empty/],
    [['--apiKey', '   '], undefined, /Error: --apiKey is set but empty/],
    [
      [],
      { SUPERGATEWAY_API_KEY: '' },
      /Error: SUPERGATEWAY_API_KEY is set but empty/,
    ],
    [
      [],
      { SUPERGATEWAY_API_KEY_FILE: '' },
      /Error: SUPERGATEWAY_API_KEY_FILE is set but empty/,
    ],
    [
      ['--apiKeyFile', missing],
      undefined,
      /Error: Cannot read --apiKeyFile .*supergateway-no-such-key-file: ENOENT/,
    ],
    [
      [],
      { SUPERGATEWAY_API_KEY_FILE: missing },
      /Error: Cannot read SUPERGATEWAY_API_KEY_FILE .*: ENOENT/,
    ],
    [
      ['--apiKeyFile', blank],
      undefined,
      /Error: --apiKeyFile .* contains no keys/,
    ],
  ]
  for (const [args, env, message] of cases) {
    const { code, text } = await refusal(
      t,
      [...(await listening()), ...args],
      env,
    )
    assert.equal(code, 1, `${args.join(' ')} ${JSON.stringify(env)}`)
    assert.match(text, message)
    assert.doesNotMatch(text, /Listening on port/)
  }
})

test(
  'a key in a bridge mode is refused, from any source',
  options,
  async (t) => {
    const missing = join(tmpdir(), 'supergateway-no-such-key-file')
    const cases: [string[], Record<string, string> | undefined][] = [
      [['--sse', 'http://127.0.0.1:9/sse', '--apiKey', KEY_ONE], undefined],
      [
        ['--streamableHttp', 'http://127.0.0.1:9/mcp', '--apiKey', KEY_ONE],
        undefined,
      ],
      // Refused before the file is read.
      [['--sse', 'http://127.0.0.1:9/sse', '--apiKeyFile', missing], undefined],
      [
        ['--streamableHttp', 'http://127.0.0.1:9/mcp'],
        { SUPERGATEWAY_API_KEY: KEY_ONE },
      ],
      [
        ['--sse', 'http://127.0.0.1:9/sse'],
        { SUPERGATEWAY_API_KEY_FILE: missing },
      ],
    ]
    for (const [args, env] of cases) {
      const { code, text } = await refusal(t, args, env)
      assert.equal(code, 1, args.join(' '))
      assert.ok(text.includes(BRIDGE_ERROR), text)
      assert.doesNotMatch(text, /Cannot read/)
      assertNoKeys(text)
    }
  },
)

// The pure parts.

const noFile = (path: string): string => {
  throw Error(`read ${path}`)
}

test('apiKeysOf: no source, no keys', () => {
  assert.deepEqual(apiKeysOf({}, {}, noFile), { keys: [] })
  assert.deepEqual(apiKeysOf({ outputTransport: 'stdio' }, {}, noFile), {
    keys: [],
  })
})

test('apiKeysOf: --apiKey, trimmed and de-duplicated', () => {
  assert.deepEqual(
    apiKeysOf(
      { apiKey: ['a', ' a ', 'b'], outputTransport: 'sse' },
      {},
      noFile,
    ),
    { keys: ['a', 'b'] },
  )
  assert.deepEqual(apiKeysOf({ apiKey: ['0123'] }, {}, noFile), {
    keys: ['0123'],
  })
})

test('apiKeysOf: an empty key is an error, wherever it came from', () => {
  const empty = (label: string) => ({
    error: `Error: ${label} is set but empty; give it a value or leave it out`,
  })
  assert.deepEqual(apiKeysOf({ apiKey: [] }, {}, noFile), empty('--apiKey'))
  assert.deepEqual(
    apiKeysOf({ apiKey: ['a', ''] }, {}, noFile),
    empty('--apiKey'),
  )
  assert.deepEqual(
    apiKeysOf({ apiKey: [' \t'] }, {}, noFile),
    empty('--apiKey'),
  )
  assert.deepEqual(
    apiKeysOf({}, { SUPERGATEWAY_API_KEY: '' }, noFile),
    empty('SUPERGATEWAY_API_KEY'),
  )
  assert.deepEqual(
    apiKeysOf({}, { SUPERGATEWAY_API_KEY: '  ' }, noFile),
    empty('SUPERGATEWAY_API_KEY'),
  )
  assert.deepEqual(
    apiKeysOf({ apiKeyFile: '' }, {}, noFile),
    empty('--apiKeyFile'),
  )
  assert.deepEqual(
    apiKeysOf({}, { SUPERGATEWAY_API_KEY_FILE: '' }, noFile),
    empty('SUPERGATEWAY_API_KEY_FILE'),
  )
})

test('apiKeysOf: SUPERGATEWAY_API_KEY alone', () => {
  assert.deepEqual(apiKeysOf({}, { SUPERGATEWAY_API_KEY: ' e ' }, noFile), {
    keys: ['e'],
  })
})

test('apiKeysOf: key files, one key per line, no comments', () => {
  const files: Record<string, string> = {
    '/cli': ' one \r\n\n# two\n\t\n',
    '/env': 'three\none',
  }
  const read = (path: string) => files[path]
  assert.deepEqual(apiKeysOf({ apiKeyFile: '/cli' }, {}, read), {
    keys: ['one', '# two'],
  })
  assert.deepEqual(apiKeysOf({}, { SUPERGATEWAY_API_KEY_FILE: '/env' }, read), {
    keys: ['three', 'one'],
  })
})

test('apiKeysOf: an unreadable or empty file is an error', () => {
  assert.deepEqual(apiKeysOf({ apiKeyFile: '/gone' }, {}, noFile), {
    error: 'Error: Cannot read --apiKeyFile /gone: read /gone',
  })
  assert.deepEqual(
    apiKeysOf({}, { SUPERGATEWAY_API_KEY_FILE: '/gone' }, noFile),
    { error: 'Error: Cannot read SUPERGATEWAY_API_KEY_FILE /gone: read /gone' },
  )
  assert.deepEqual(
    apiKeysOf({ apiKeyFile: '/blank' }, {}, () => ' \n\n'),
    {
      error: 'Error: --apiKeyFile /blank contains no keys',
    },
  )
  assert.deepEqual(
    apiKeysOf({}, { SUPERGATEWAY_API_KEY_FILE: '/blank' }, () => ''),
    { error: 'Error: SUPERGATEWAY_API_KEY_FILE /blank contains no keys' },
  )
})

test('apiKeysOf: every source at once is their union', () => {
  assert.deepEqual(
    apiKeysOf(
      { apiKey: ['a'], apiKeyFile: '/f', outputTransport: 'ws' },
      { SUPERGATEWAY_API_KEY: 'b', SUPERGATEWAY_API_KEY_FILE: '/g' },
      (path) => (path === '/f' ? 'c\na' : 'd'),
    ),
    { keys: ['a', 'b', 'c', 'd'] },
  )
})

test('apiKeysOf: each source alone is refused in a bridge mode', () => {
  const bridge = { error: BRIDGE_ERROR }
  const outputTransport = 'stdio'
  assert.deepEqual(
    apiKeysOf({ apiKey: ['a'], outputTransport }, {}, noFile),
    bridge,
  )
  assert.deepEqual(
    apiKeysOf({ apiKey: [], outputTransport }, {}, noFile),
    bridge,
  )
  assert.deepEqual(
    apiKeysOf({ apiKeyFile: '/f', outputTransport }, {}, noFile),
    bridge,
  )
  assert.deepEqual(
    apiKeysOf({ outputTransport }, { SUPERGATEWAY_API_KEY: 'a' }, noFile),
    bridge,
  )
  assert.deepEqual(
    apiKeysOf({ outputTransport }, { SUPERGATEWAY_API_KEY_FILE: '/f' }, noFile),
    bridge,
  )
})

test('acceptsApiKey: Bearer in any case, or X-API-Key', () => {
  const accepts = acceptsApiKey(['k1', 'k2'])
  for (const authorization of [
    'Bearer k1',
    'bearer k2',
    'BEARER k1',
    'Bearer \tk1',
  ])
    assert.equal(accepts({ authorization }), true, authorization)
  assert.equal(accepts({ 'x-api-key': 'k2' }), true)
  // One good credential is enough, whichever header carries it.
  assert.equal(accepts({ authorization: 'Basic xyz', 'x-api-key': 'k1' }), true)
  assert.equal(
    accepts({ authorization: 'Bearer nope', 'x-api-key': 'k1' }),
    true,
  )
  assert.equal(
    accepts({ authorization: 'Bearer k1', 'x-api-key': 'nope' }),
    true,
  )
})

test('acceptsApiKey: anything else is refused', () => {
  const accepts = acceptsApiKey(['k1'])
  assert.equal(accepts({}), false)
  for (const authorization of [
    'Bearer',
    'Bearer ',
    'Basic k1',
    'k1',
    'Bearerk1',
    'Bearer k',
    'Bearer k1x',
  ])
    assert.equal(accepts({ authorization }), false, authorization)
  assert.equal(accepts({ 'x-api-key': '' }), false)
  assert.equal(accepts({ 'x-api-key': 'K1' }), false)
  assert.equal(accepts({ 'x-api-key': ['k1', 'k1'] }), false)
})

test('acceptsApiKey: a UTF-8 key matches the bytes a client sends', () => {
  const key = 'clé-🔑'
  const wire = Buffer.from(key, 'utf8').toString('latin1')
  assert.equal(acceptsApiKey([key])({ 'x-api-key': wire }), true)
  assert.equal(acceptsApiKey([key])({ 'x-api-key': key }), false)
})

test('logApiKeys: said only when there are keys, counted', () => {
  const lines: string[] = []
  const logger = { info: (line: string) => lines.push(line), error: () => {} }
  logApiKeys(logger, [])
  assert.deepEqual(lines, [])
  logApiKeys(logger, ['secret-a'])
  logApiKeys(logger, ['secret-a', 'secret-b'])
  assert.deepEqual(lines, [
    '  - API key: required (1 key)',
    '  - API key: required (2 keys)',
  ])
})

test('with no keys, the middleware passes through and ws checks nothing', () => {
  const logger = { info: () => assert.fail('logged'), error: () => {} }
  let passed = false
  requireApiKey([], logger)(
    { headers: {} } as never,
    {} as never,
    () => (passed = true),
  )
  assert.equal(passed, true)
  assert.equal(verifyApiKey([], logger), undefined)
})
