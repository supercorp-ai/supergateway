import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import fc from 'fast-check'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

const peer = 'node tests/helpers/session-state-peer.mjs'

async function setup(t: TestContext, timeout?: number) {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peer,
    '--outputTransport',
    'streamableHttp',
    '--stateful',
    '--port',
    String(port),
    ...(timeout ? ['--sessionTimeout', String(timeout)] : []),
  ])
  await gateway.ready()
  const url = `http://127.0.0.1:${port}/mcp`
  const open = async () => {
    const result = await rpc(url, initialize())
    assert.equal(result.response.status, 200)
    const session = result.response.headers.get('mcp-session-id')!
    assert.ok(session)
    const pid = Number(result.messages[0].result.serverInfo.version)
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.equal(
      (
        await rpc(
          url,
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          session,
        )
      ).response.status,
      202,
    )
    return { session, pid, calls: 0 }
  }
  const step = async (state: Awaited<ReturnType<typeof open>>) => {
    // Reusing an ID after its reply is valid. Compare the payload, not HTTP 200.
    const result = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'step', arguments: {} },
      },
      state.session,
    )
    assert.equal(result.response.status, 200)
    assert.equal(result.messages.length, 1)
    assert.equal(result.messages[0].id, 7)
    assert.deepEqual(JSON.parse(result.messages[0].result.content[0].text), {
      pid: state.pid,
      calls: ++state.calls,
    })
  }
  const close = async (session: string) => {
    const response = await fetch(url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': session },
      signal: AbortSignal.timeout(3000),
    })
    await response.text()
    assert.equal(response.status, 200)
  }
  const stream = async (session: string) => {
    const abort = new AbortController()
    t.after(() => abort.abort())
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': session },
      signal: abort.signal,
    })
    assert.equal(response.status, 200)
    // Drain immediately and retain settlement so aborts never become unhandled.
    const ended = response.text().catch(() => '')
    return {
      abort: async () => {
        abort.abort()
        await ended
      },
    }
  }
  return { gateway, url, open, step, close, stream }
}

test(
  'stateful sessions preserve the same peer and application state across a three-second response gap',
  { timeout: 15000 },
  async (t) => {
    const b = await setup(t)
    const a = await b.open(),
      other = await b.open()
    assert.notEqual(a.pid, other.pid)
    await b.step(a)
    await b.step(other)
    await delay(3100)
    await b.step(a)
    await b.step(other)
    await b.close(a.session)
    await b.step(other)
    const expired = await rpc(
      b.url,
      { jsonrpc: '2.0', id: 8, method: 'tools/list' },
      a.session,
    )
    assert.ok(expired.response.status >= 400 && expired.response.status < 500)
  },
)

test(
  'closing an HTTP connection and a GET stream does not terminate a stateful session with no idle timeout',
  { timeout: 15000 },
  async (t) => {
    const b = await setup(t)
    const a = await b.open()
    const response = await fetch(b.url, {
      method: 'POST',
      headers: {
        connection: 'close',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': a.session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' }),
      signal: AbortSignal.timeout(3000),
    })
    assert.equal(response.status, 200)
    await response.text()
    const first = await b.stream(a.session)
    await first.abort()
    await b.step(a)
    const second = await b.stream(a.session)
    await b.step(a)
    await second.abort()
    await b.step(a)
  },
)

test(
  'an open GET stream prevents idle expiry and a new request cancels pending expiry',
  { timeout: 20000 },
  async (t) => {
    const b = await setup(t, 1200)
    const a = await b.open()
    const held = await b.stream(a.session)
    await delay(1700)
    await b.step(a)
    await held.abort()
    await b.gateway.waitFor(
      () => b.gateway.output().includes(`GET response closed`),
      'observe GET closure',
    )
    await delay(300)
    const renewed = await b.stream(a.session)
    await delay(1700)
    await b.step(a)
    await renewed.abort()
    await b.gateway.waitFor(
      () => b.gateway.output().includes(`Session ${a.session} timed out`),
      'expire only after the last active stream ends',
    )
    const expired = await rpc(
      b.url,
      { jsonrpc: '2.0', id: 8, method: 'tools/list' },
      a.session,
    )
    assert.ok(expired.response.status >= 400 && expired.response.status < 500)
    const fresh = await b.open()
    assert.notEqual(fresh.session, a.session)
    await b.step(fresh)
  },
)

test(
  'stateful session identity survives seeded interleavings of calls, stream disconnects and another session ending',
  { timeout: 90000 },
  async (t) => {
    // Two sessions always exist; unlike a random open/use/close array this cannot
    // degenerate into mostly no-ops. Every use checks both identity and state.
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 0, max: 3 }), {
          minLength: 10,
          maxLength: 16,
        }),
        async (operations) => {
          const b = await setup(t)
          try {
            const sessions = [await b.open(), await b.open()]
            for (const operation of operations) {
              const index = operation % 2
              if (operation < 2) await b.step(sessions[index])
              else {
                const held = await b.stream(sessions[index].session)
                await b.step(sessions[1 - index])
                await held.abort()
                await b.step(sessions[index])
              }
            }
            await b.close(sessions[0].session)
            await b.step(sessions[1])
            const fresh = await b.open()
            assert.notEqual(fresh.session, sessions[0].session)
            await b.step(fresh)
          } finally {
            await b.gateway.dispose()
          }
        },
      ),
      {
        seed: Number(process.env.LIFECYCLE_SEED ?? 141182),
        numRuns: Number(process.env.LIFECYCLE_RUNS ?? 8),
      },
    )
  },
)

test(
  'simultaneous calls with equal IDs in different stateful sessions preserve each peer and result',
  { timeout: 15000 },
  async (t) => {
    const b = await setup(t)
    const a = await b.open(),
      other = await b.open()
    assert.notEqual(a.pid, other.pid)
    for (let round = 0; round < 8; round++) {
      await Promise.all([b.step(a), b.step(other)])
    }
    await b.close(a.session)
    await b.step(other)
  },
)
