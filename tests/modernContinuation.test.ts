// A 2026-07-28 operation that asks the client for input spans HTTP exchanges.
// The stdio server signs its continuation state with a process-local key, so
// the client's next round has to reach the process that minted it.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

const VERSION = '2026-07-28'
const ROOTS = { roots: [{ uri: 'file:///scratch', name: 'scratch' }] }
const meta = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'continuation', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': { roots: {} },
}
type Event = { pid: number; event: string; round?: number }

async function setup(
  t: TestContext,
  stateful: boolean,
  env: Record<string, string> = {},
  args: string[] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), 'modern-continuation-'))
  const tracePath = join(directory, 'trace.jsonl')
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      'node tests/helpers/signed-continuation-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      ...(stateful ? ['--stateful'] : []),
      ...args,
    ],
    { ...env, CONTINUATION_TRACE: tracePath },
  )
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  await gateway.ready()
  const trace = (): Event[] => {
    try {
      return readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const pids = (event: string) =>
    trace()
      .filter((entry) => entry.event === event)
      .map((entry) => entry.pid)
  return { gateway, url: `http://127.0.0.1:${port}/mcp`, trace, pids }
}

async function connect(t: TestContext, url: string) {
  const client = new Client(
    { name: 'continuation', version: '1' },
    {
      capabilities: { roots: {} },
      versionNegotiation: { mode: { pin: VERSION } },
    },
  )
  client.setRequestHandler('roots/list', async () => ROOTS)
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), {
    timeout: 5000,
  })
  return client
}

async function callRoots(client: Client, rounds = 1) {
  const result = await client.callTool(
    { name: 'roots', arguments: { rounds } },
    { timeout: 10000 },
  )
  return JSON.parse((result.content as any[])[0].text)
}

// The raw client controls when, and whether, the next round is sent.
async function post(url: string, id: number, params: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': 'roots',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { _meta: meta, name: 'roots', arguments: {}, ...params },
    }),
  })
  const text = await res.text()
  const message = text.startsWith('event:')
    ? JSON.parse(
        text
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5),
      )
    : JSON.parse(text)
  return { status: res.status, message }
}
const continuation = (requestState: string) => ({
  inputResponses: { locations: ROOTS },
  requestState,
})

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function eventually(check: () => boolean, description: string) {
  const deadline = Date.now() + 8000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(description)
    await delay(25)
  }
}

for (const stateful of [false, true]) {
  const label = stateful ? 'stateful flag' : 'stateless'

  test(
    `${label}: signed continuation state resumes on the process that minted it`,
    { timeout: 20000 },
    async (t) => {
      const { gateway, url, pids } = await setup(t, stateful)
      const client = await connect(t, url)
      // Connecting ran discovery in its own short-lived process.
      const discovered = pids('start').length
      const value = await callRoots(client)
      assert.equal(value.state.value, 'backend-owned signed state')
      assert.deepEqual(value.roots, ROOTS)
      assert.equal(
        pids('start').length - discovered,
        1,
        'one process served both rounds',
      )
      assert.deepEqual(pids('resume'), pids('mint'))
      assert.equal(value.state.pid, pids('mint')[0])
      gateway.signal('SIGTERM')
      await gateway.exited
      await eventually(
        () => pids('start').every((pid) => !alive(pid)),
        'shutdown releases the completed continuation',
      )
    },
  )

  test(
    `${label}: every round of a longer operation reaches the same process`,
    { timeout: 20000 },
    async (t) => {
      const { gateway, url, pids, trace } = await setup(t, stateful)
      const client = await connect(t, url)
      const discovered = pids('start').length
      const value = await callRoots(client, 3)
      assert.equal(value.round, 3)
      assert.equal(value.state.round, 3)
      assert.equal(pids('start').length - discovered, 1)
      const rounds = trace().filter((event) => event.event !== 'start')
      assert.deepEqual(
        rounds.map((event) => [event.event, event.round]),
        [
          ['mint', 1],
          ['resume', 1],
          ['mint', 2],
          ['resume', 2],
          ['mint', 3],
          ['resume', 3],
        ],
      )
      assert.equal(new Set(rounds.map((event) => event.pid)).size, 1)
      gateway.signal('SIGTERM')
      await gateway.exited
      await eventually(
        () => pids('start').every((pid) => !alive(pid)),
        'shutdown releases the completed continuation',
      )
    },
  )

  test(
    `${label}: concurrent operations each resume on their own process`,
    { timeout: 20000 },
    async (t) => {
      const { gateway, url, pids } = await setup(t, stateful)
      const clients = await Promise.all([connect(t, url), connect(t, url)])
      const discovered = pids('start').length
      const values = await Promise.all(
        clients.map((client) => callRoots(client)),
      )
      const minted = new Set(pids('mint'))
      assert.equal(minted.size, 2)
      for (const value of values) assert.ok(minted.has(value.state.pid))
      assert.equal(new Set(values.map((value) => value.state.pid)).size, 2)
      assert.deepEqual(new Set(pids('resume')), minted)
      assert.equal(pids('start').length - discovered, 2)
      gateway.signal('SIGTERM')
      await gateway.exited
      await eventually(
        () => pids('start').every((pid) => !alive(pid)),
        'shutdown releases both completed continuations',
      )
    },
  )

  test(
    `${label}: an abandoned operation keeps its process waiting until the gateway shuts down`,
    { timeout: 20000 },
    async (t) => {
      const { gateway, url, pids } = await setup(t, stateful)
      const first = await post(url, 1, {})
      assert.equal(first.status, 200)
      assert.equal(first.message.result.resultType, 'input_required')
      assert.equal(typeof first.message.result.requestState, 'string')
      const [minter] = pids('mint')
      await delay(500)
      assert.ok(alive(minter), 'the process waits for the next round')
      gateway.signal('SIGTERM')
      assert.equal((await gateway.exited).code, 0)
      await eventually(
        () => !alive(minter),
        'shutdown releases the waiting process',
      )
    },
  )

  test(
    `${label}: identical unsigned state from three processes stays isolated`,
    { timeout: 20000 },
    async (t) => {
      const { url, pids } = await setup(t, stateful, {
        CONTINUATION_CONSTANT_STATE: '1',
      })
      const replies = await Promise.all(
        [1, 2, 3].map((id) => post(url, id, {})),
      )
      const handles = replies.map((reply) => reply.message.result.requestState)
      assert.equal(new Set(handles).size, 3)
      const minted = pids('mint')
      for (let i = 0; i < 3; i++) {
        const resumed = await post(url, 10 + i, continuation(handles[i]))
        assert.equal(resumed.status, 200)
        const value = JSON.parse(resumed.message.result.content[0].text)
        assert.equal(value.state.value, 'constant:1')
      }
      assert.equal(pids('start').length, 3)
      assert.deepEqual(new Set(pids('resume')), new Set(minted))
    },
  )
}
