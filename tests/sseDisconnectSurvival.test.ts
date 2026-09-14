import test from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * A client that vanishes must not be able to take the gateway down with it.
 *
 * `stdioToSse.ts` fans every child message out to every session without
 * awaiting the send and without a rejection handler. `SSEServerTransport.send`
 * is async, so a delivery to a transport whose response is gone rejects rather
 * than throwing, and nothing in `src/` installs an `unhandledRejection`
 * handler — Node terminates the process by default. The only reason that does
 * not happen today is ordering: the `close` handler on the SSE response removes
 * the session before the next fan-out can reach it.
 *
 * That ordering is load-bearing and invisible. This test pins it, because the
 * fix for GW-017 rewrites exactly this code — how replies are routed to
 * sessions — and a regression here is not a failed request but a dead gateway
 * taking every unrelated client with it.
 */
test(
  'an abruptly dropped SSE client does not take the gateway down',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(port),
    ])
    await gateway.ready()

    const connect = async (signal?: AbortSignal) => {
      const response = await fetch(`http://127.0.0.1:${port}/sse`, {
        headers: { accept: 'text/event-stream' },
        signal,
      })
      assert.equal(response.status, 200)
      const frames: string[] = []
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      void (async () => {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines)
            if (line.startsWith('data:')) frames.push(line.slice(5).trim())
        }
      })().catch(() => {})
      await gateway.waitFor(
        () => frames.some((frame) => frame.startsWith('/message')),
        'announce a message endpoint for the session',
      )
      return { frames, endpoint: frames.find((f) => f.startsWith('/message'))! }
    }

    const doomed = new AbortController()
    await connect(doomed.signal)
    const survivor = await connect()

    // Drop the first client's socket mid-stream, the way a killed client or a
    // dead network does — no close frame, no graceful shutdown.
    doomed.abort()
    await gateway.waitFor(
      () => /SSE connection closed/.test(gateway.output()),
      'notice the dropped connection',
    )

    // Now make the gateway fan a message out. Every session in its map is
    // written to, so if the dropped one is still there this is where it fails.
    await fetch(`http://127.0.0.1:${port}${survivor.endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/list' }),
    })
    await gateway.waitFor(
      () => survivor.frames.some((frame) => frame.includes('"id":91')),
      'still answer the client that stayed',
    )

    assert.equal(
      gateway.child.exitCode,
      null,
      'the gateway must still be running after a client disappears',
    )
    assert.equal(
      gateway.child.signalCode,
      null,
      'and must not have been killed',
    )

    // And it must still be able to take new work, not merely be alive.
    const latecomer = await connect()
    assert.ok(
      latecomer.endpoint.startsWith('/message'),
      'a client arriving after the disconnect is served normally',
    )
  },
)
