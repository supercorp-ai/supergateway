import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  McpError,
  ResultSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'
import { intended } from './crossVersion.intended.js'

/**
 * Released versions run beside this build, and what a client sees is compared.
 *
 * The same client does the same things against a released gateway and against
 * this one: a whole MCP session over each transport, the HTTP answers a client
 * or a proxy can meet, the command line's refusals, and the startup log. Then
 * the two are chained, an old bridge in front of a new gateway and a new
 * bridge in front of an old one, as happens when one side is upgraded first.
 *
 * Everything observed must be equal. What is meant to differ is written down
 * in `crossVersion.intended.ts`, both sides and the reason, and is checked
 * too: a difference that is not listed fails, and so does a listed one that
 * is no longer there.
 *
 * The released versions come from npm, so this runs only where
 * SUPERGATEWAY_BASELINES names the directory `scripts/install-baselines.mjs`
 * filled: `npm run test:versions`, and the "Released versions" job in CI.
 */

const baselineDir = process.env.SUPERGATEWAY_BASELINES
const candidate = resolve(
  process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js',
)
const versions: string[] = Object.keys(
  JSON.parse(readFileSync('tests/crossVersion.baselines.json', 'utf8')),
)
const entryOf = (version: string) =>
  resolve(baselineDir!, version, 'node_modules/supergateway/dist/index.js')

const peer = `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve('tests/helpers/conformance-peer.mjs'))}`
const options = { timeout: gatewayTimeout(240000) }

type Observed = Record<string, unknown>

// --- What is observed is made comparable: nothing that names a run. ---

const scrub = (text: string, ports: number[]) =>
  ports
    .reduce((all, port, i) => all.replaceAll(String(port), `<port${i}>`), text)
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      '<uuid>',
    )
    .replace(/\b\d+\.\d+\.\d+(-rc\.\d+)?\b/g, '<version>')
    .replace(/\bpid[= ]\d+/gi, 'pid=<pid>')

const comparable = (value: unknown, ports: number[]): unknown =>
  JSON.parse(scrub(JSON.stringify(value ?? null), ports))

const failure = (error: unknown) =>
  error instanceof McpError
    ? {
        error: {
          code: error.code,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      }
    : { error: String((error as Error)?.message ?? error) }

// --- Launching a version. ---

function launch(t: TestContext, entry: string, args: string[]) {
  const previous = process.env.SUPERGATEWAY_TEST_ENTRY
  process.env.SUPERGATEWAY_TEST_ENTRY = entry
  try {
    return launchGateway(t, args)
  } finally {
    if (previous === undefined) delete process.env.SUPERGATEWAY_TEST_ENTRY
    else process.env.SUPERGATEWAY_TEST_ENTRY = previous
  }
}

const TRANSPORTS = {
  sse: ['--outputTransport', 'sse'],
  ws: ['--outputTransport', 'ws'],
  stateless: ['--outputTransport', 'streamableHttp'],
  stateful: ['--outputTransport', 'streamableHttp', '--stateful'],
} as const
type TransportName = keyof typeof TRANSPORTS

async function gateway(
  t: TestContext,
  entry: string,
  transport: TransportName,
  extra: string[] = [],
  server = peer,
) {
  const port = await unusedPort()
  const process_ = launch(t, entry, [
    '--stdio',
    server,
    '--port',
    String(port),
    ...TRANSPORTS[transport],
    ...extra,
  ])
  await process_.ready()
  return { port, process: process_, base: `http://127.0.0.1:${port}` }
}

const clientTransport = (transport: TransportName, base: string): Transport =>
  transport === 'sse'
    ? new SSEClientTransport(new URL(`${base}/sse`))
    : transport === 'ws'
      ? new WebSocketClientTransport(
          new URL(`${base.replace('http', 'ws')}/message`),
        )
      : new StreamableHTTPClientTransport(new URL(`${base}/mcp`))

// --- A whole MCP session, and everything the client got back. ---

async function session(
  t: TestContext,
  transport: Transport,
  ports: number[],
): Promise<Observed> {
  const seen: Observed = {}
  const logs: unknown[] = []
  const client = new Client(
    { name: 'cross-version', version: '1' },
    { capabilities: { sampling: {}, elicitation: {}, roots: {} } },
  )
  client.setRequestHandler(CreateMessageRequestSchema, async (request) => ({
    role: 'assistant',
    model: 'fixture',
    content: {
      type: 'text',
      text: `sampled ${request.params.messages.length} message(s)`,
    },
  }))
  client.setRequestHandler(ElicitRequestSchema, async () => ({
    action: 'accept',
    content: { username: 'ada', email: 'ada@example.com' },
  }))
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots: [{ uri: 'file:///scratch', name: 'scratch' }],
  }))
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push(n.params)
  })
  t.after(() => client.close().catch(() => {}))

  const timeout = { timeout: requestTimeout(15000) }
  const step = async (name: string, run: () => Promise<unknown>) => {
    seen[name] = comparable(await run().catch(failure), ports)
  }
  const call = (name: string, args: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: args }, undefined, timeout)

  await step('connect', async () => {
    await client.connect(transport, timeout)
    return {
      server: client.getServerVersion(),
      capabilities: client.getServerCapabilities(),
      instructions: client.getInstructions() ?? null,
    }
  })
  await step('ping', () => client.ping(timeout))
  await step('tools/list', () => client.listTools(undefined, timeout))
  await step('prompts/list', () => client.listPrompts(undefined, timeout))
  await step('resources/list', () => client.listResources(undefined, timeout))
  await step('resources/templates/list', () =>
    client.listResourceTemplates(undefined, timeout),
  )
  for (const tool of [
    'test_simple_text',
    'test_image_content',
    'test_audio_content',
    'test_embedded_resource',
    'test_multiple_content_types',
    'test_error_handling',
  ])
    await step(`call ${tool}`, () => call(tool))
  await step('call with logging', async () => ({
    result: await call('test_tool_with_logging'),
    logs: logs.splice(0),
  }))
  await step('call with progress', async () => {
    const progress: unknown[] = []
    const result = await client.callTool(
      { name: 'test_tool_with_progress', arguments: {} },
      undefined,
      { ...timeout, onprogress: (update) => progress.push(update) },
    )
    return { result, progress }
  })
  await step('call that samples the client', () =>
    call('test_sampling', { prompt: 'hello' }),
  )
  await step('call that asks the user', () =>
    call('test_elicitation', { message: 'who are you?' }),
  )
  await step('call an unknown tool', () => call('no_such_tool'))
  await step('prompts/get', () =>
    client.getPrompt({ name: 'test_simple_prompt' }, timeout),
  )
  await step('prompts/get with arguments', () =>
    client.getPrompt(
      {
        name: 'test_prompt_with_arguments',
        arguments: { arg1: 'a', arg2: 'b' },
      },
      timeout,
    ),
  )
  await step('prompts/get unknown', () =>
    client.getPrompt({ name: 'no_such_prompt' }, timeout),
  )
  for (const uri of [
    'test://static-text',
    'test://static-binary',
    'test://template/7/data',
    'test://no-such-resource',
  ])
    await step(`resources/read ${uri}`, () =>
      client.readResource({ uri }, timeout),
    )
  await step('resources/subscribe', () =>
    client.subscribeResource({ uri: 'test://watched-resource' }, timeout),
  )
  await step('completion/complete', () =>
    client.complete(
      {
        ref: { type: 'ref/prompt', name: 'test_prompt_with_arguments' },
        argument: { name: 'arg1', value: 'pa' },
      },
      timeout,
    ),
  )
  await step('logging/setLevel', () => client.setLoggingLevel('debug', timeout))
  await step('an unknown method', () =>
    client.request({ method: 'no/such/method' }, ResultSchema, timeout),
  )
  await step('close', () => client.close())
  return seen
}

// --- The HTTP answers a client or a proxy can meet, without an SDK. ---

async function http(
  base: string,
  ports: number[],
  path: string,
  init: RequestInit & { read?: 'first-event' } = {},
) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), requestTimeout(8000))
  try {
    const response = await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
    })
    const headers = Object.fromEntries(
      [
        'content-type',
        'cache-control',
        'allow',
        'access-control-allow-origin',
        'access-control-allow-headers',
        'access-control-expose-headers',
        'x-team',
        'www-authenticate',
      ]
        .map((name) => [name, response.headers.get(name)])
        .filter(([, value]) => value !== null),
    )
    const session = response.headers.get('mcp-session-id')
    let body: string
    if (init.read === 'first-event') {
      // An event stream never ends: its first event is what there is to read.
      const reader = response.body!.getReader()
      let text = ''
      while (!text.includes('\n\n')) {
        const { value, done } = await reader.read()
        if (done) break
        text += Buffer.from(value).toString('utf8')
      }
      body = text.slice(0, text.indexOf('\n\n'))
    } else body = await response.text()
    controller.abort()
    return {
      session,
      seen: comparable(
        {
          status: response.status,
          headers,
          sessionHeader: session === null ? 'absent' : 'present',
          body,
        },
        ports,
      ),
    }
  } catch (error) {
    return { session: null, seen: { failed: String((error as Error).message) } }
  } finally {
    clearTimeout(timer)
  }
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...headers,
  },
  body: typeof body === 'string' ? body : JSON.stringify(body),
})
const initializeRequest = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1' },
  },
}
const listRequest = { jsonrpc: '2.0', id: 2, method: 'tools/list' }
const SHARED = [
  '--healthEndpoint',
  '/healthz',
  '--cors',
  '--header',
  'x-team: core',
]

async function httpAnswers(t: TestContext, entry: string): Promise<Observed> {
  const seen: Observed = {}

  const sse = await gateway(t, entry, 'sse', SHARED)
  const ask = async (
    name: string,
    base: { base: string; port: number },
    path: string,
    init?: Parameters<typeof http>[3],
  ) => {
    const answer = await http(base.base, [base.port], path, init)
    seen[name] = answer.seen
    return answer
  }
  await ask('sse: health', sse, '/healthz')
  await ask('sse: preflight', sse, '/message', {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  })
  await ask('sse: the event stream opens', sse, '/sse', { read: 'first-event' })
  await ask(
    'sse: a message with no session',
    sse,
    '/message',
    json(listRequest),
  )
  await ask(
    'sse: a message for an unknown session',
    sse,
    '/message?sessionId=00000000-0000-4000-8000-000000000000',
    json(listRequest),
  )
  await ask('sse: an unknown path', sse, '/nowhere')
  await ask('sse: POST to the stream path', sse, '/sse', json(listRequest))

  const stateless = await gateway(t, entry, 'stateless', SHARED)
  const mcp = (
    name: string,
    target: { base: string; port: number },
    init?: Parameters<typeof http>[3],
  ) => ask(name, target, '/mcp', init)
  await ask('stateless: health', stateless, '/healthz')
  await mcp('stateless: initialize', stateless, json(initializeRequest))
  await mcp(
    'stateless: a request with no initialize',
    stateless,
    json(listRequest),
  )
  await mcp(
    'stateless: a notification',
    stateless,
    json({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  )
  await mcp(
    'stateless: a batch',
    stateless,
    json([listRequest, { jsonrpc: '2.0', id: 3, method: 'ping' }]),
  )
  await mcp('stateless: not JSON', stateless, json('{"jsonrpc": '))
  await mcp('stateless: not a JSON-RPC message', stateless, json({ hello: 1 }))
  await mcp(
    'stateless: an unknown method',
    stateless,
    json({ jsonrpc: '2.0', id: 4, method: 'no/such/method' }),
  )
  await mcp(
    'stateless: an unsupported protocol version header',
    stateless,
    json(listRequest, { 'mcp-protocol-version': '1999-01-01' }),
  )
  await mcp('stateless: the wrong content type', stateless, {
    method: 'POST',
    headers: { 'content-type': 'text/plain', accept: 'application/json' },
    body: JSON.stringify(listRequest),
  })
  await mcp('stateless: Accept without event-stream', stateless, {
    ...json(listRequest),
    headers: { 'content-type': 'application/json', accept: 'application/json' },
  })
  await mcp('stateless: GET', stateless, {
    headers: { accept: 'text/event-stream' },
  })
  await mcp('stateless: DELETE', stateless, { method: 'DELETE' })
  await mcp('stateless: preflight', stateless, {
    method: 'OPTIONS',
    headers: {
      origin: 'https://app.example',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type, mcp-session-id',
    },
  })

  const stateful = await gateway(t, entry, 'stateful', SHARED)
  await mcp('stateful: a request with no session', stateful, json(listRequest))
  await mcp(
    'stateful: a request for an unknown session',
    stateful,
    json(listRequest, {
      'mcp-session-id': '00000000-0000-4000-8000-000000000000',
    }),
  )
  await mcp('stateful: GET with no session', stateful, {
    headers: { accept: 'text/event-stream' },
  })
  const opened = await mcp(
    'stateful: initialize',
    stateful,
    json(initializeRequest),
  )
  const held = { 'mcp-session-id': opened.session ?? 'none' }
  await mcp(
    'stateful: initialized',
    stateful,
    json({ jsonrpc: '2.0', method: 'notifications/initialized' }, held),
  )
  await mcp(
    'stateful: a request in the session',
    stateful,
    json(listRequest, held),
  )
  await mcp(
    'stateful: initialize again in the session',
    stateful,
    json(initializeRequest, held),
  )
  await mcp('stateful: DELETE the session', stateful, {
    method: 'DELETE',
    headers: held,
  })
  await mcp(
    'stateful: a request after DELETE',
    stateful,
    json(listRequest, held),
  )
  return seen
}

// --- The command line: what it refuses, what it logs, how it stops. ---

function run(entry: string, args: string[]) {
  return new Promise<{ code: number | null; output: string }>((done) => {
    const child = spawn(process.execPath, [entry, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => (output += chunk))
    child.stderr.on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => child.kill('SIGKILL'), requestTimeout(10000))
    child.on('exit', (code) => {
      clearTimeout(timer)
      done({ code, output })
    })
  })
}

// What a refusal says, without what differs by nature: the option listing
// yargs prints before its message grows with every new flag, and a stack
// trace names the files of the version it came from.
const said = (output: string) =>
  output
    .split('\n')
    .filter((line) => line.trim() && !/^\s/.test(line) && line !== 'Options:')

// The ready line is not the last line of a startup log: wait until the log
// has said nothing more for a moment.
async function quiet(read: () => string) {
  for (let before = -1; before !== read().length;) {
    before = read().length
    await new Promise((resolve) => setTimeout(resolve, requestTimeout(400)))
  }
}

const flagsOf = (help: string) =>
  [...help.matchAll(/^\s+(--[A-Za-z][\w-]*)/gm)].map((match) => match[1]).sort()

async function commandLine(t: TestContext, entry: string): Promise<Observed> {
  const seen: Observed = {}
  for (const [name, args] of Object.entries({
    'no arguments': [],
    'two inputs': ['--stdio', 'x', '--sse', 'http://127.0.0.1:1/sse'],
    'an output that does not exist': [
      '--stdio',
      'x',
      '--outputTransport',
      'carrier-pigeon',
    ],
    'stdio to stdio': ['--stdio', 'x', '--outputTransport', 'stdio'],
    'a remote URL with credentials': [
      '--sse',
      'http://user:secret@127.0.0.1:1/sse',
    ],
    'a session timeout that is not a number': [
      '--stdio',
      'x',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      'soon',
    ],
  })) {
    const { code, output } = await run(entry, args)
    seen[`refuses ${name}`] = comparable({ code, said: said(output) }, [])
  }
  seen['flags in --help'] = flagsOf((await run(entry, ['--help'])).output)

  // The whole startup log is compared below. Here, only what is said about
  // an option the gateway does not have.
  const odd = await gateway(t, entry, 'sse', ['--keepAlive', '30'])
  await quiet(() => odd.process.output() + odd.process.errors())
  seen['sse: an option that does not exist, in the log'] = (
    odd.process.output() + odd.process.errors()
  )
    .split('\n')
    .filter((line) => line.includes('keepAlive'))

  for (const transport of Object.keys(TRANSPORTS) as TransportName[]) {
    const started = await gateway(t, entry, transport)
    const log = () => started.process.output() + started.process.errors()
    await quiet(log)
    seen[`${transport}: startup log`] = comparable(
      log().replaceAll(peer, '<server>'),
      [started.port],
    )
    const before = log().length
    started.process.child.kill('SIGTERM')
    const { code, signal } = await started.process.exited
    seen[`${transport}: SIGTERM`] = comparable(
      { code, signal, log: log().slice(before) },
      [started.port],
    )
  }
  return seen
}

// --- Comparing. ---

function compare(
  group: string,
  version: string,
  baseline: Observed,
  current: Observed,
) {
  const listed = intended[version]?.[group] ?? {}
  const unexpected: string[] = []
  for (const key of new Set([
    ...Object.keys(baseline),
    ...Object.keys(current),
  ])) {
    const was = baseline[key]
    const now = current[key]
    const entry = listed[key]
    let equal = true
    try {
      assert.deepStrictEqual(now, was)
    } catch {
      equal = false
    }
    if (equal) {
      if (entry)
        unexpected.push(
          `${key}: listed as an intended difference, but ${version} and this build now agree. Remove it from crossVersion.intended.ts.`,
        )
      continue
    }
    if (!entry) {
      unexpected.push(
        `${key}: differs from ${version}, and is not an intended difference.\n  ${version}: ${JSON.stringify(was)}\n  this build: ${JSON.stringify(now)}`,
      )
      continue
    }
    try {
      assert.deepStrictEqual(was, entry.was)
      assert.deepStrictEqual(now, entry.now)
    } catch {
      unexpected.push(
        `${key}: differs from ${version}, but not as crossVersion.intended.ts says.\n  ${version}: ${JSON.stringify(was)}\n  this build: ${JSON.stringify(now)}`,
      )
    }
  }
  for (const key of Object.keys(listed))
    if (!(key in baseline) && !(key in current))
      unexpected.push(
        `${key}: listed in crossVersion.intended.ts, never observed.`,
      )
  assert.deepEqual(unexpected, [], `${group}, against ${version}`)
}

// --- The tests. ---

const skip = !baselineDir
  ? 'set SUPERGATEWAY_BASELINES (npm run test:versions)'
  : !existsSync(join(baselineDir))
    ? `${baselineDir} does not exist (node scripts/install-baselines.mjs)`
    : false

for (const version of versions) {
  for (const transport of Object.keys(TRANSPORTS) as TransportName[])
    test(
      `a client's session over ${transport} is what it was in ${version}`,
      { ...options, skip },
      async (t) => {
        const observe = async (entry: string) => {
          const started = await gateway(t, entry, transport)
          return session(t, clientTransport(transport, started.base), [
            started.port,
          ])
        }
        compare(
          `session over ${transport}`,
          version,
          await observe(entryOf(version)),
          await observe(candidate),
        )
      },
    )

  test(
    `HTTP answers are what they were in ${version}`,
    { ...options, skip },
    async (t) => {
      compare(
        'HTTP answers',
        version,
        await httpAnswers(t, entryOf(version)),
        await httpAnswers(t, candidate),
      )
    },
  )

  test(
    `the command line is what it was in ${version}`,
    { ...options, skip },
    async (t) => {
      const was = await commandLine(t, entryOf(version))
      const now = await commandLine(t, candidate)
      // A release may add flags. It may not take one away.
      const gone = (was['flags in --help'] as string[]).filter(
        (flag) => !(now['flags in --help'] as string[]).includes(flag),
      )
      assert.deepEqual(gone, [], `flags of ${version} missing from --help`)
      delete was['flags in --help']
      delete now['flags in --help']
      compare('command line', version, was, now)
    },
  )

  // A server's own error code, through each version's bridge.
  for (const [transport, flag, path] of [
    ['sse', '--sse', '/sse'],
    ['stateful', '--streamableHttp', '/mcp'],
  ] as const)
    test(
      `a server's application error through the ${flag} bridge is what it was in ${version}`,
      { ...options, skip },
      async (t) => {
        const through = async (bridge: string) => {
          const started = await gateway(
            t,
            candidate,
            transport,
            [],
            `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve('tests/helpers/app-error-peer.mjs'))}`,
          )
          const client = new Client({ name: 'cross-version', version: '1' })
          t.after(() => client.close().catch(() => {}))
          await client.connect(
            new StdioClientTransport({
              command: process.execPath,
              args: [bridge, flag, `${started.base}${path}`],
              stderr: 'ignore',
            }),
          )
          return {
            'tools/list': comparable(await client.listTools().catch(failure), [
              started.port,
            ]),
          }
        }
        compare(
          `application error through ${flag}`,
          version,
          await through(entryOf(version)),
          await through(candidate),
        )
      },
    )

  // One side upgraded first: an old bridge in front of this gateway, and
  // this bridge in front of an old gateway. Each must give the client what
  // this build gives it at both ends.
  for (const [transport, flag, path] of [
    ['sse', '--sse', '/sse'],
    ['stateless', '--streamableHttp', '/mcp'],
    ['stateful', '--streamableHttp', '/mcp'],
  ] as const)
    test(
      `${version} and this build work as bridge and gateway of each other over ${transport}`,
      { ...options, skip },
      async (t) => {
        const through = async (bridge: string, served: string) => {
          const started = await gateway(t, served, transport)
          return session(
            t,
            new StdioClientTransport({
              command: process.execPath,
              args: [bridge, flag, `${started.base}${path}`],
              stderr: 'ignore',
            }),
            [started.port],
          )
        }
        const old = entryOf(version)
        const both = await through(candidate, candidate)
        compare(
          `bridge of ${version}, gateway of this build, over ${transport}`,
          version,
          await through(old, candidate),
          both,
        )
        compare(
          `bridge of this build, gateway of ${version}, over ${transport}`,
          version,
          await through(candidate, old),
          both,
        )
      },
    )
}
