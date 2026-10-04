import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  requestTimeout,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// With several calls in flight on one stateful session, a call's progress
// belongs on that call's response stream. It used to ride the first call in
// flight, whichever it was for: delivered, but on a stream that closes when
// the first call is answered, which another call's later progress would miss.

// A call whose response stream is read as it arrives.
const openCall = async (
  t: TestContext,
  url: string,
  session: string,
  id: number,
  meta?: Record<string, unknown>,
) => {
  const aborting = new AbortController()
  t.after(() => aborting.abort())
  const response = await fetch(url, {
    method: 'POST',
    signal: aborting.signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': session,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      // "wait" reports progress, if asked to, and never answers.
      params: { name: 'wait', arguments: {}, ...(meta ? { _meta: meta } : {}) },
    }),
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  // One read at a time: a read that outlives its wait still gets the next
  // chunk, so it is kept for the next wait.
  let reading: ReturnType<typeof reader.read> | undefined
  // The messages that arrive on this call's stream within `ms`.
  const within = async (ms: number) => {
    const deadline = delay(ms, 'time' as const, { ref: false })
    let text = ''
    while (!text.includes('\n\n')) {
      reading ??= reader.read()
      const chunk = await Promise.race([reading, deadline])
      if (chunk === 'time') break
      reading = undefined
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
    return text
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => JSON.parse(line.slice(5)))
  }
  return { within }
}

test(
  "progress arrives on its own call's stream, not the first call in flight",
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/modern-bridge-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const session = (await rpc(url, initialize())).response.headers.get(
      'mcp-session-id',
    )!
    // The first call in flight asks for no progress.
    const first = await openCall(t, url, session, 10)
    await gateway.waitFor(
      () => gateway.output().includes('"id":10'),
      'pass the first call on',
    )
    const second = await openCall(t, url, session, 11, {
      progressToken: 'second',
    })
    assert.deepEqual(await second.within(requestTimeout(4000)), [
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'second', progress: 1, total: 2 },
      },
    ])
    assert.deepEqual(await first.within(300), [])

    // A call that is answered takes its token with it; the others keep
    // theirs.
    const answered = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { value: 'done' },
          _meta: { progressToken: 'third' },
        },
      },
      session,
    )
    assert.equal(answered.messages.at(-1).result.content[0].text, 'done')

    // Progress under a token no call in flight sent rides the first call,
    // as everything but progress does.
    const stray = await rpc(
      url,
      { jsonrpc: '2.0', id: 13, method: 'custom/stream-error' },
      session,
    )
    assert.equal(stray.messages.at(-1).error.code, -32601)
    assert.deepEqual(await first.within(requestTimeout(4000)), [
      {
        jsonrpc: '2.0',
        method: 'notifications/progress',
        params: { progressToken: 'p', progress: 1 },
      },
    ])
  },
)
