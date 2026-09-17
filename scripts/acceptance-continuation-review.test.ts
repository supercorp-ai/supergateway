// Opt-in regression review of merged PR198; these assertions currently fail.
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
import { launchGateway, unusedPort } from '../tests/helpers/gateway-process.js'

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
  test(
    `review ${stateful}: a third identical token must not make a known collision routable`,
    { timeout: 20000 },
    async (t) => {
      const { url, pids } = await setup(t, stateful, {
        CONTINUATION_CONSTANT_STATE: '1',
      })
      const a = await post(url, 1, {})
      const b = await post(url, 2, {})
      assert.equal(a.message.result.requestState, b.message.result.requestState)
      await eventually(
        () => pids('mint').every((pid) => !alive(pid)),
        'the first collision releases both processes',
      )
      const c = await post(url, 3, {})
      assert.equal(c.message.result.requestState, a.message.result.requestState)
      const result = await post(
        url,
        4,
        continuation(a.message.result.requestState),
      )
      assert.equal(result.status, 200)
      assert.equal(result.message.error, undefined)
      console.log(
        JSON.stringify({
          case: 'third-collision',
          stateful,
          minted: pids('mint'),
          resumed: pids('resume'),
        }),
      )
      assert.ok(
        !pids('mint').includes(pids('resume')[0]),
        "the first caller must not resume in the third caller\'s process after a known token collision",
      )
    },
  )

  test(
    `review ${stateful}: explicit retry after final response keeps backend acceptance`,
    { timeout: 20000 },
    async (t) => {
      const { url, pids } = await setup(t, stateful)
      const first = await post(url, 1, {})
      const params = continuation(first.message.result.requestState)
      const completed = await post(url, 2, params)
      assert.equal(completed.message.error, undefined)
      const retry = await post(url, 3, params)
      console.log(
        JSON.stringify({
          case: 'retry-after-final',
          stateful,
          completed: completed.message,
          retry: retry.message,
          starts: pids('start'),
        }),
      )
      assert.equal(
        retry.message.error,
        undefined,
        'the same still-valid signed state works when the backend remains directly connected',
      )
      assert.deepEqual(retry.message.result, completed.message.result)
    },
  )
}

import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
test(
  'direct stdio control accepts the same signed continuation after a final response',
  { timeout: 10000 },
  async (t) => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['tests/helpers/signed-continuation-peer.mjs'],
    })
    t.after(() => transport.close())
    const pending = new Map<number, (value: any) => void>()
    transport.onmessage = (message) => {
      if ('id' in message) pending.get(message.id as number)?.(message)
    }
    await transport.start()
    const request = async (id: number, extra: Record<string, unknown>) => {
      const reply = new Promise<any>((resolve) => pending.set(id, resolve))
      await transport.send({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { _meta: meta, name: 'roots', arguments: {}, ...extra },
      })
      try {
        return await reply
      } finally {
        pending.delete(id)
      }
    }
    const first = await request(1, {})
    const params = continuation(first.result.requestState)
    const completed = await request(2, params)
    const retry = await request(3, params)
    assert.equal(completed.error, undefined)
    assert.equal(retry.error, undefined)
    assert.deepEqual(retry.result, completed.result)
  },
)
