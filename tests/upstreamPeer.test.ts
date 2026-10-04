import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { upstreamPeer } from '../src/lib/upstreamPeer.js'
import { OwnedChildProcesses } from '../src/lib/ownedChildProcesses.js'
import type { ChildOwner } from '../src/lib/childHandoff.js'

// A session with a remote Streamable HTTP server, against a scripted `fetch`:
// what the peer sends, and how fast it reads what comes back.

const logger = { info() {}, error() {} }
const sse = (...messages: object[]) =>
  messages.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`)

// A `fetch` that answers each POST with the next scripted SSE body, chunk by
// chunk as it is pulled, and records each request and pull.
const scripted = (t: TestContext, bodies: string[][]) => {
  const requests: { method: string; headers: Headers; body: unknown }[] = []
  let pulls = 0
  t.mock.method(
    globalThis,
    'fetch',
    async (_url: unknown, init: RequestInit) => {
      requests.push({
        method: init.method!,
        headers: new Headers(init.headers),
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      })
      if (init.method !== 'POST') return new Response(null, { status: 405 })
      const chunks = [...(bodies.shift() ?? [])]
      if (chunks.length === 0) return new Response(null, { status: 202 })
      return new Response(
        new ReadableStream(
          {
            pull(controller) {
              pulls++
              const chunk = chunks.shift()
              if (chunk === undefined) controller.close()
              else controller.enqueue(new TextEncoder().encode(chunk))
            },
            // Pulled only when read: nothing is fetched ahead.
          },
          { highWaterMark: 0 },
        ),
        {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'mcp-session-id': 'remote-session',
          },
        },
      )
    },
  )
  return { requests, pulls: () => pulls }
}

const owner = (output: () => Promise<void> | undefined = () => undefined) => {
  const received: unknown[] = []
  const failures: Error[] = []
  const sink: ChildOwner = {
    message: (message) => received.push(message),
    nonJson() {},
    stderr() {},
    failure: (_kind, err) => failures.push(err),
    exit() {},
    output,
  }
  return { sink, received, failures }
}

const start = (sink: ChildOwner) =>
  upstreamPeer(
    {
      url: new URL('http://remote.test/mcp'),
      type: 'streamableHttp',
      headers: { authorization: 'Bearer upstream' },
    },
    new OwnedChildProcesses(logger),
    logger,
    'Session',
  )(sink)

const initialize = (id: number) => ({
  jsonrpc: '2.0' as const,
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0.0' },
  },
})

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await delay(5)
}

test('later requests declare the version initialize settled on', async (t) => {
  const remote = scripted(t, [
    sse({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }),
    sse({ jsonrpc: '2.0', id: 2, result: {} }),
  ])
  const { sink, received } = owner()
  const peer = start(sink)
  peer.write(initialize(1))
  peer.write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await until(() => received.length === 2)
  const [first, second] = remote.requests
  // map: the configured credentials on every request
  assert.equal(first.headers.get('authorization'), 'Bearer upstream')
  // map: initialize first, then the version it settled on, in the session
  assert.equal(first.headers.get('mcp-protocol-version'), null)
  assert.equal((second.body as { method: string }).method, 'tools/list')
  assert.equal(second.headers.get('mcp-protocol-version'), '2025-06-18')
  assert.equal(second.headers.get('mcp-session-id'), 'remote-session')
  await peer.stop()
})

test('a refused initialize settles no version', async (t) => {
  const remote = scripted(t, [
    sse({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'no' } }),
    sse({ jsonrpc: '2.0', id: 2, result: {} }),
  ])
  const { sink, received } = owner()
  const peer = start(sink)
  peer.write(initialize(1))
  await until(() => received.length === 1)
  peer.write({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  await until(() => received.length === 2)
  // map: the error reaches the client, and no version is declared after it
  assert.deepEqual((received[0] as { error: object }).error, {
    code: -32600,
    message: 'no',
  })
  assert.equal(remote.requests[1].headers.get('mcp-protocol-version'), null)
  await peer.stop()
})

test('the remote server is read only as fast as its client reads', async (t) => {
  const remote = scripted(t, [
    sse(
      { jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/message', params: {} },
    ),
  ])
  let caughtUp!: () => void
  let behind: Promise<void> | undefined = new Promise(
    (resolve) => (caughtUp = resolve),
  )
  const { sink, received } = owner(() => behind)
  const peer = start(sink)
  peer.write(initialize(1))
  await until(() => remote.requests.length === 1)
  await delay(50)
  // map: nothing read while the client is behind
  assert.equal(remote.pulls(), 0)
  assert.equal(received.length, 0)
  behind = undefined
  caughtUp()
  await until(() => received.length === 2)
  // map: everything, in order, once it caught up
  assert.deepEqual(
    received.map((m) => ('id' in (m as object) ? 'answer' : 'notification')),
    ['answer', 'notification'],
  )
  await peer.stop()
})
