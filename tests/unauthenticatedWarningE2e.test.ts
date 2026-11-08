import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import os, { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  listening,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// #360 end to end, against the built CLI: which gateways warn that they serve
// MCP to anyone who can reach them, in which words, on which stream, and
// that nothing else about them changes.

const prefix = '[supergateway] '
const options = { timeout: gatewayTimeout(30000) }
const mockServer = resolve('tests/helpers/mock-mcp-server.js')
const remoteServer = resolve('tests/helpers/remote-mcp-server.mjs')
const mock = { command: process.execPath, args: [mockServer, 'stdio'] }

type Gateway = ReturnType<typeof launchGateway>

const canBind = (host: string) =>
  new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(0, host, () => server.close(() => resolve(true)))
  })

const noIpv6 = (await canBind('::1')) ? false : 'IPv6 is not available'
const noLoopbackAlias = (await canBind('127.0.0.2'))
  ? false
  : '127.0.0.2 is not configured on this machine'
const lanAddress = Object.values(os.networkInterfaces())
  .flat()
  .find((net) => net && net.family === 'IPv4' && !net.internal)?.address
const noLan = lanAddress ? false : 'no non-loopback IPv4 interface'

const outputs: Record<string, string[]> = {
  SSE: ['--outputTransport', 'sse'],
  WS: ['--outputTransport', 'ws'],
  'stateless Streamable HTTP': ['--outputTransport', 'streamableHttp'],
  'stateful Streamable HTTP': [
    '--outputTransport',
    'streamableHttp',
    '--stateful',
  ],
}

// A gateway that serves the mock server, once it is ready.
const gateway = async (
  t: TestContext,
  args: string[],
  env?: Record<string, string>,
) => {
  const port = await unusedPort()
  const started = launchGateway(
    t,
    ['--stdio', peerCommand, '--port', String(port), ...args],
    env,
  )
  await started.ready()
  return { port, gateway: started }
}

// Everything the gateway wrote, once it has stopped: the warning is written
// in the same tick as the listing, so nothing can still be on its way.
const stopped = async (gateway: Gateway) => {
  const closed = once(gateway.child, 'close')
  await gateway.dispose()
  await closed
  return { stdout: gateway.output(), stderr: gateway.errors() }
}

const warnings = (text: string) =>
  text.split('\n').filter((line) => line.includes('WARNING: No API key'))

const everyInterface = (port: number) =>
  `${prefix}WARNING: No API key is set, so anyone who can reach port ${port} on this machine (the gateway listens on every network interface) can use the MCP server. Set --apiKey or SUPERGATEWAY_API_KEY to require a key, or --host 127.0.0.1 to accept local connections only.`

// --- Who warns ---

for (const [mode, args] of Object.entries(outputs)) {
  test(
    `${mode} without --host or a key warns once, on stderr, in these words`,
    options,
    async (t) => {
      const { port, gateway: started } = await gateway(t, args)
      const { stdout, stderr } = await stopped(started)
      assert.deepEqual(warnings(stderr), [everyInterface(port)])
      assert.deepEqual(warnings(stdout), [])
    },
  )
}

for (const wildcard of ['0.0.0.0', '::'])
  test(
    `--host ${wildcard} is every interface too`,
    { ...options, skip: wildcard === '::' ? noIpv6 : false },
    async (t) => {
      const { port, gateway: started } = await gateway(t, ['--host', wildcard])
      assert.deepEqual(warnings((await stopped(started)).stderr), [
        everyInterface(port),
      ])
    },
  )

test(
  'a LAN address is named with its port',
  { ...options, skip: noLan },
  async (t) => {
    const { port, gateway: started } = await gateway(t, ['--host', lanAddress!])
    assert.deepEqual(warnings((await stopped(started)).stderr), [
      `${prefix}WARNING: No API key is set, so anyone who can reach ${lanAddress}:${port} can use the MCP server. Set --apiKey or SUPERGATEWAY_API_KEY to require a key, or --host 127.0.0.1 to accept local connections only.`,
    ])
  },
)

// --- Who doesn't ---

const loopbacks: [string, string | false][] = [
  ['127.0.0.1', false],
  ['localhost', false],
  ['::1', noIpv6],
  ['[::1]', noIpv6],
  ['::ffff:127.0.0.1', noIpv6],
  ['127.0.0.2', noLoopbackAlias],
]
for (const [host, skip] of loopbacks)
  test(
    `--host ${host} is local, and says nothing`,
    { ...options, skip },
    async (t) => {
      const { gateway: started } = await gateway(t, ['--host', host])
      assert.deepEqual(warnings((await stopped(started)).stderr), [])
    },
  )

const keyFile = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-keys-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }))
  const path = join(dir, 'keys')
  writeFileSync(path, 'file-key\n')
  return path
}

const keySources: [
  string,
  (t: TestContext) => { args: string[]; env?: Record<string, string> },
][] = [
  ['--apiKey', () => ({ args: ['--apiKey', 'k'] })],
  ['--apiKeyFile', (t) => ({ args: ['--apiKeyFile', keyFile(t)] })],
  [
    'SUPERGATEWAY_API_KEY',
    () => ({ args: [], env: { SUPERGATEWAY_API_KEY: 'k' } }),
  ],
  [
    'SUPERGATEWAY_API_KEY_FILE',
    (t) => ({ args: [], env: { SUPERGATEWAY_API_KEY_FILE: keyFile(t) } }),
  ],
]
for (const [mode, output] of Object.entries(outputs))
  for (const [source, keyed] of keySources)
    test(
      `${mode} with a key from ${source} says nothing`,
      options,
      async (t) => {
        const { args, env } = keyed(t)
        const { gateway: started } = await gateway(t, [...output, ...args], env)
        assert.deepEqual(warnings((await stopped(started)).stderr), [])
      },
    )

// --- Remote servers ---

const startRemote = async (t: TestContext) => {
  const port = await unusedPort()
  const child = spawn(process.execPath, [remoteServer], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => {
    child.kill()
  })
  await once(child.stdout, 'data')
  return port
}

test(
  'a remote server served over Streamable HTTP warns like a local one',
  options,
  async (t) => {
    const remote = await startRemote(t)
    const port = await unusedPort()
    const started = launchGateway(t, [
      '--streamableHttp',
      `http://127.0.0.1:${remote}/mcp`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await started.ready()
    assert.deepEqual(warnings((await stopped(started)).stderr), [
      everyInterface(port),
    ])
  },
)

test(
  'a bridge to stdio listens on nothing, and says nothing',
  options,
  async (t) => {
    const remote = await startRemote(t)
    const started = launchGateway(t, [
      '--streamableHttp',
      `http://127.0.0.1:${remote}/mcp`,
    ])
    await started.ready()
    assert.deepEqual(warnings((await stopped(started)).stderr), [])
  },
)

// --- Log settings ---

test(
  '--logLevel none keeps the warning and nothing else',
  options,
  async (t) => {
    const port = await unusedPort()
    const started = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(port),
      '--logLevel',
      'none',
    ])
    // Not ready by its log, which is off: by its port.
    await listening(port, '127.0.0.1')
    const { stdout, stderr } = await stopped(started)
    assert.equal(stdout, '')
    assert.equal(stderr, `${everyInterface(port)}\n`)
  },
)

test('--logLevel debug warns exactly once', options, async (t) => {
  const { port, gateway: started } = await gateway(t, ['--logLevel', 'debug'])
  assert.deepEqual(warnings((await stopped(started)).stderr), [
    everyInterface(port),
  ])
})

test(
  '--logFormat json puts the words in msg, without a server field',
  options,
  async (t) => {
    const { port, gateway: started } = await gateway(t, ['--logFormat', 'json'])
    const lines = (await stopped(started)).stderr
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((line) => String(line.msg).startsWith('WARNING: No API key'))
    assert.equal(lines.length, 1)
    assert.equal(lines[0].level, 'error')
    assert.equal(lines[0].msg, everyInterface(port).slice(prefix.length))
    assert.equal('server' in lines[0], false)
    assert.equal('data' in lines[0], false)
  },
)

// --- Clients see nothing new ---

for (const [mode, args] of Object.entries(outputs).filter(([mode]) =>
  mode.includes('Streamable'),
))
  test(
    `${mode}: a client without a key is still served`,
    options,
    async (t) => {
      const { port, gateway: started } = await gateway(t, args)
      const { response, messages } = await rpc(
        `http://127.0.0.1:${port}/mcp`,
        initialize(1),
      )
      assert.equal(response.status, 200)
      assert.equal(messages[0].result.serverInfo.name, 'mock-server')
      assert.equal(warnings((await stopped(started)).stderr).length, 1)
    },
  )

// --- Config files ---

const writeConfig = (t: TestContext, value: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }))
  const path = join(dir, 'servers.json')
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

const serveConfig = async (
  t: TestContext,
  config: Record<string, unknown>,
  args: string[] = [],
) => {
  const port = await unusedPort()
  const started = launchGateway(t, [
    '--config',
    writeConfig(t, { port, ...config }),
    ...args,
  ])
  await started.ready()
  return { port, gateway: started }
}

const http = { ...mock, outputTransport: 'streamableHttp' }

const configWarning = (
  port: number,
  servers: string,
  them: string,
  those: string,
) =>
  `${prefix}WARNING: No API key is set for ${servers}, so anyone who can reach port ${port} on this machine (the gateway listens on every network interface) can use ${them}. Set "apiKey" on ${those} in the config file, --apiKey or SUPERGATEWAY_API_KEY to require a key on every server, or --host 127.0.0.1 to accept local connections only.`

test('a config file names its one server without a key', options, async (t) => {
  const { port, gateway: started } = await serveConfig(t, {
    mcpServers: { tools: { ...http, apiKey: 'k' }, open: http },
  })
  assert.deepEqual(warnings((await stopped(started)).stderr), [
    configWarning(port, '"open"', 'it', 'that server'),
  ])
})

test(
  'a config file names every server without a key, in order, once',
  options,
  async (t) => {
    const { port, gateway: started } = await serveConfig(t, {
      mcpServers: { b: http, keyed: { ...http, apiKey: 'k' }, a: mock },
    })
    assert.deepEqual(warnings((await stopped(started)).stderr), [
      configWarning(port, '"b" and "a"', 'them', 'those servers'),
    ])
  },
)

// A file with one server runs exactly as the command line it stands for
// (configParity.test.ts), so it warns in the command line's words.
test(
  'a config file with one server warns as its command line does',
  options,
  async (t) => {
    const { port, gateway: started } = await serveConfig(t, {
      mcpServers: { only: http },
    })
    assert.deepEqual(warnings((await stopped(started)).stderr), [
      everyInterface(port),
    ])
  },
)

for (const [how, config, args] of [
  [
    'an apiKey on every server',
    {
      mcpServers: { a: { ...http, apiKey: 'k' }, b: { ...mock, apiKey: 'j' } },
    },
    [],
  ],
  ['a top-level apiKey', { apiKey: 'k', mcpServers: { a: http, b: mock } }, []],
  [
    '--apiKey beside --config',
    { mcpServers: { a: http, b: mock } },
    ['--apiKey', 'k'],
  ],
  [
    'a loopback host in the file',
    { host: '127.0.0.1', mcpServers: { a: http } },
    [],
  ],
  [
    '--host 127.0.0.1 beside --config',
    { mcpServers: { a: http } },
    ['--host', '127.0.0.1'],
  ],
] as [string, Record<string, unknown>, string[]][])
  test(`a config file with ${how} says nothing`, options, async (t) => {
    const { gateway: started } = await serveConfig(t, config, args)
    assert.deepEqual(warnings((await stopped(started)).stderr), [])
  })

test(
  'beside a server on stdio, the warning is the last startup line',
  options,
  async (t) => {
    const remote = await startRemote(t)
    const { port, gateway: started } = await serveConfig(t, {
      mcpServers: {
        bridged: { url: `http://127.0.0.1:${remote}/mcp`, type: 'http' },
        open: http,
      },
    })
    // Every line goes to stderr here, so their order is the order written.
    await started.waitFor(() => warnings(started.errors()).length > 0, 'warn')
    const lines = started.errors().split('\n')
    const at = lines.findIndex((line) => line.includes('WARNING: No API key'))
    assert.ok(
      lines.slice(0, at).some((line) => line.includes('Listening on port')),
      started.errors(),
    )
    assert.equal(lines[at], configWarning(port, '"open"', 'it', 'that server'))
    // The bridged server is on stdio: not named, and stdout stays MCP only.
    assert.equal(started.output(), '')
  },
)

test(
  'a server on stdio beside keyed servers says nothing',
  options,
  async (t) => {
    const remote = await startRemote(t)
    const { gateway: started } = await serveConfig(t, {
      mcpServers: {
        bridged: { url: `http://127.0.0.1:${remote}/mcp`, type: 'http' },
        keyed: { ...http, apiKey: 'k' },
      },
    })
    assert.deepEqual(warnings((await stopped(started)).stderr), [])
  },
)
