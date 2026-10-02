import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { parseCli, unknownArguments } from '../src/cli.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

const option = (spelling: string) =>
  `Ignored unknown option ${spelling} (see --help)`
const argument = (arg: string) =>
  `Ignored unexpected argument ${arg} (an --stdio command with spaces must be quoted)`

// The warnings for a command line, read the way the gateway reads it.
const warningsFor = (args: string[]) => unknownArguments(args, parseCli(args))

// Every declared option once, with a value it accepts. Spelled camelCase here
// and kebab-case below; yargs accepts both for every option.
const known = [
  ['--stdio', peerCommand],
  ['--sse', 'http://127.0.0.1:1/sse'],
  ['--streamableHttp', 'http://127.0.0.1:1/mcp'],
  ['--outputTransport', 'sse'],
  ['--port', '8000'],
  ['--baseUrl', 'http://localhost:8000'],
  ['--ssePath', '/sse'],
  ['--messagePath', '/message'],
  ['--streamableHttpPath', '/mcp'],
  ['--logLevel', 'info'],
  ['--cors', 'http://example.com'],
  ['--healthEndpoint', '/healthz'],
  ['--header', 'x-user-id: 123'],
  ['--oauth2Bearer', 'token'],
  ['--stateful'],
  ['--sessionTimeout', '1000'],
  ['--protocolVersion', '2025-03-26'],
]
const kebab = (flag: string) =>
  flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)

test('every declared option is known in its camelCase spelling', () => {
  assert.deepEqual(warningsFor(known.flat()), [])
})

test('every declared option is known in its kebab-case spelling', () => {
  const args = known.flatMap(([flag, ...value]) => [kebab(flag), ...value])
  assert.ok(args.includes('--streamable-http-path'), 'the spellings differ')
  assert.deepEqual(warningsFor(args), [])
})

test('an unknown camelCase option is warned once, as typed', () => {
  assert.deepEqual(warningsFor(['--stdio', 'x', '--keepAlive']), [
    option('--keepAlive'),
  ])
})

test('an unknown kebab-case option is warned once, as typed', () => {
  // yargs files it under both `keep-alive` and `keepAlive`.
  const args = ['--stdio', 'x', '--keep-alive', '5']
  assert.ok(Object.keys(parseCli(args)).includes('keepAlive'))
  assert.deepEqual(warningsFor(args), [option('--keep-alive')])
})

test('an option typed in both spellings is warned once, as first typed', () => {
  assert.deepEqual(
    warningsFor(['--keep-alive', '--keepAlive', '--bindAddress=x']),
    [option('--keep-alive'), option('--bindAddress')],
  )
})

test('a name is camel-cased only when it has a hyphen, as yargs does', () => {
  // `--LOG-LEVEL` sets logLevel; `--STDIO` and `--log_level` set nothing.
  assert.deepEqual(parseCli(['--LOG-LEVEL', 'none']).logLevel, 'none')
  assert.deepEqual(warningsFor(['--LOG-LEVEL', 'none']), [])
  assert.deepEqual(warningsFor(['--STDIO', 'x', '--log_level', 'none']), [
    option('--STDIO'),
    option('--log_level'),
  ])
})

test('an option given its value with = is warned by its name', () => {
  assert.deepEqual(warningsFor(['--keepAlive=5', '--transport=sse']), [
    option('--keepAlive'),
    option('--transport'),
  ])
})

test('short options are warned one letter at a time', () => {
  assert.deepEqual(warningsFor(['-xz', '-n=1']), [
    option('-x'),
    option('-z'),
    option('-n'),
  ])
  // A value is not a cluster of short options: `--x` is not reported as `-x`.
  assert.deepEqual(warningsFor(['--stdio', 'npx', '--x']), [option('--x')])
})

test('a negated unknown option is warned as typed, a negated known one is not', () => {
  assert.deepEqual(warningsFor(['--no-stateful', '--no-color']), [
    option('--no-color'),
  ])
})

test('the options inside a quoted --stdio command are its own', () => {
  assert.deepEqual(warningsFor(['--stdio', 'node x --foo -y']), [])
  assert.deepEqual(warningsFor(['--stdio=node x --foo -y']), [])
})

test('a quoted header and value-less or repeated array options are known', () => {
  assert.deepEqual(
    warningsFor([
      '--header',
      'x-user-id: 123',
      '--cors',
      '--healthEndpoint',
      '/healthz',
      '--health-endpoint',
      '/readyz',
    ]),
    [],
  )
})

test('an unquoted --stdio command leaves its flags and arguments behind', () => {
  // yargs gives `-y` the next argument as its value, so a bare package name
  // is not a positional; whatever follows it is.
  assert.deepEqual(warningsFor(['--stdio', 'npx', '-y', '@scope/server']), [
    option('-y'),
  ])
  assert.deepEqual(
    warningsFor(['--stdio', 'npx', '-y', '@scope/server', '/tmp', '/tmp', '8']),
    [option('-y'), argument('/tmp'), argument('8')],
  )
})

test('arguments after -- are unexpected too, each once', () => {
  assert.deepEqual(warningsFor(['--stdio', 'x', '--', 'a', '--b', 'a']), [
    argument('a'),
    argument('--b'),
  ])
})

test('an option not found among the arguments is named in kebab-case', () => {
  assert.deepEqual(unknownArguments([], { _: [], keepAlive: true }), [
    option('--keep-alive'),
  ])
  // A dotted option is filed under its first segment.
  assert.deepEqual(warningsFor(['--a.b', '1']), [option('--a')])
})

test("yargs' own options and keys are not warned", () => {
  assert.deepEqual(
    unknownArguments(['--help', '--version'], {
      _: [],
      $0: 'supergateway',
      help: true,
      version: true,
    }),
    [],
  )
})

test('a command line with nothing unknown has no warnings', () => {
  assert.deepEqual(warningsFor(['--stdio', peerCommand]), [])
})

const prefix = '[supergateway] '
const lines = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))
const banner =
  'Supergateway is supported by Supercov - Coverage for coding agents and software factories 🌙 - https://supercov.com'

// The stdio→SSE startup, as it is printed today, up to its last ready line.
const sseStartup = (port: number, stdio: string) => [
  'Starting...',
  banner,
  '  - outputTransport: sse',
  '  - Headers: (none)',
  `  - port: ${port}`,
  `  - stdio: ${stdio}`,
  '  - ssePath: /sse',
  '  - messagePath: /message',
  '  - CORS: disabled',
  '  - Health endpoints: (none)',
  `Listening on port ${port}`,
  `SSE endpoint: http://localhost:${port}/sse`,
  `POST messages: http://localhost:${port}/message`,
]

const startSse = async (
  t: Parameters<typeof launchGateway>[0],
  extra: string[],
) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--port',
    String(port),
    ...extra,
  ])
  await gateway.ready()
  await gateway.waitFor(
    () => gateway.output().includes('POST messages:'),
    'finish announcing the SSE listener',
  )
  return { gateway, port }
}

test(
  'with nothing unknown, the startup output is unchanged',
  { timeout: gatewayTimeout(15000) },
  async (t) => {
    const { gateway, port } = await startSse(t, [])
    assert.equal(
      gateway.output(),
      sseStartup(port, peerCommand)
        .map((line) => prefix + line + '\n')
        .join(''),
    )
    assert.equal(gateway.errors(), '')
  },
)

test(
  'known options in both spellings start the gateway without a warning',
  { timeout: gatewayTimeout(15000) },
  async (t) => {
    const { gateway, port } = await startSse(t, [
      '--log-level',
      'info',
      '--logLevel',
      'info',
      '--message-path',
      '/message',
      '--ssePath',
      '/sse',
    ])
    assert.deepEqual(lines(gateway.output()), sseStartup(port, peerCommand))
    assert.equal(gateway.errors(), '')
  },
)

test(
  'unknown options are warned once each on stderr, and nothing else changes',
  { timeout: gatewayTimeout(15000) },
  async (t) => {
    const { gateway, port } = await startSse(t, [
      '--keepAlive',
      '--keep-alive2',
      '30',
      '--transport',
      'sse',
    ])
    assert.deepEqual(lines(gateway.output()), sseStartup(port, peerCommand))
    assert.equal(
      gateway.errors(),
      [option('--keepAlive'), option('--keep-alive2'), option('--transport')]
        .map((line) => prefix + line + '\n')
        .join(''),
    )
  },
)

test(
  'the warnings come before anything else the gateway prints',
  { timeout: gatewayTimeout(15000) },
  async (t) => {
    // A stdio output puts every log line on stderr, so their order shows.
    const gateway = launchGateway(t, [
      '--sse',
      'http://127.0.0.1:54321/events',
      '--bindAddress',
      '0.0.0.0',
    ])
    await gateway.ready()
    assert.deepEqual(lines(gateway.errors()).slice(0, 2), [
      option('--bindAddress'),
      'Starting...',
    ])
  },
)

test(
  'a quoted --stdio command keeps its own options, and the gateway serves',
  { timeout: gatewayTimeout(15000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      `${peerCommand} --foo`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const { messages } = await rpc(`http://127.0.0.1:${port}/mcp`, initialize())
    assert.equal(messages[0].result.serverInfo.name, 'mock-server')
    assert.equal(gateway.errors(), '')
  },
)

test(
  'after warning, the gateway still starts and serves',
  { timeout: gatewayTimeout(15000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      '--bindAddress',
      '0.0.0.0',
    ])
    await gateway.ready()
    const { messages } = await rpc(`http://127.0.0.1:${port}/mcp`, initialize())
    assert.equal(messages[0].result.serverInfo.name, 'mock-server')
    assert.deepEqual(lines(gateway.errors()), [option('--bindAddress')])
  },
)

test(
  'an unquoted --stdio command is named, flag and argument',
  { timeout: gatewayTimeout(15000) },
  async (t) => {
    const port = await unusedPort()
    // The command runs only when a client connects, and none does.
    const gateway = launchGateway(t, [
      '--stdio',
      'npx',
      '-y',
      '@scope/server',
      '/tmp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    assert.deepEqual(lines(gateway.errors()), [option('-y'), argument('/tmp')])
    assert.ok(lines(gateway.output()).includes('  - stdio: npx'))
  },
)

test(
  '--logLevel none silences the warnings too',
  { timeout: gatewayTimeout(15000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(port),
      '--healthEndpoint',
      '/healthz',
      '--logLevel',
      'none',
      '--bindAddress',
      '0.0.0.0',
      'stray',
    ])
    // Nothing is logged, so readiness is the health endpoint answering.
    let healthy = false
    let stopped = false
    const poll = async () => {
      while (!healthy && !stopped) {
        healthy = await fetch(`http://127.0.0.1:${port}/healthz`)
          .then((response) => response.ok)
          .catch(() => false)
        await delay(20)
      }
    }
    const polling = poll()
    try {
      await gateway.waitFor(() => healthy, 'answer its health endpoint')
    } finally {
      stopped = true
      await polling
    }
    assert.equal(gateway.errors(), '')
    assert.equal(gateway.output(), '')
  },
)
