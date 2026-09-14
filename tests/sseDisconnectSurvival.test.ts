import test from 'node:test'
import assert from 'node:assert/strict'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

const noisyPeerCommand = 'node tests/helpers/noisy-mcp-server.js stdio'

/**
 * A client that vanishes must not be able to take the gateway down with it.
 *
 * `stdioToSse.ts` fans every child message out to every session without
 * awaiting the send and without a rejection handler. `SSEServerTransport.send`
 * is async, so a delivery to a transport whose response is gone rejects rather
 * than throwing, and nothing in `src/` installs an `unhandledRejection`
 * handler — Node terminates the process. The only reason that never fires is
 * ordering: the `close` handler on the SSE response removes the session before
 * the reply arrives to be fanned out.
 *
 * The window is opened deliberately here rather than waited for. The `delayed`
 * tool holds the reply for 100ms, so the socket is aborted while the request is
 * still in flight and the fan-out is guaranteed to happen after the disconnect.
 *
 * One client at a time, on purpose: two concurrent SSE clients is GW-017, which
 * newer SDKs refuse outright, while this property holds on every supported
 * version. Reconnecting afterwards is deliberately left to
 * `sseReconnect.test.ts` — on SDK 1.26 and up that is a *second* defect and it
 * kills the process, which would mask this one.
 *
 * Verified load-bearing by mutation — remove the session cleanup from the
 * compiled gateway and this fails because the process is gone, not because a
 * request failed.
 */
test(
  'an abruptly dropped SSE client does not take the gateway down',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      noisyPeerCommand,
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
    const client = await connect(doomed.signal)

    // Ask for something slow, so the reply is still in flight below.
    await fetch(`http://127.0.0.1:${port}${client.endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 91,
        method: 'tools/call',
        params: { name: 'delayed', arguments: {} },
      }),
    })

    // Drop the socket mid-request, the way a killed client or a dead network
    // does — no close frame, no graceful shutdown.
    doomed.abort()
    await gateway.waitFor(
      () => /SSE connection closed/.test(gateway.output()),
      'notice the dropped connection',
    )

    // The reply now arrives with nobody to give it to, and the fan-out writes
    // to every session still in the map. This is the moment under test.
    await gateway.waitFor(
      () => /Child → SSE[\s\S]*id: 91/.test(gateway.output()),
      'fan out the reply that arrived after the client left',
    )

    // The fan-out is logged before the send is attempted, so asserting
    // liveness immediately would race a process that is about to die. Ask the
    // HTTP server something harmless instead: a reply proves it is still
    // serving, and getting one costs exactly the round trip the rejection
    // needs to surface. Deliberately not a second /sse connection — on SDK
    // 1.26 and up that is GW-017 and would kill the gateway by itself.
    const stillServing = await fetch(
      `http://127.0.0.1:${port}/message?sessionId=not-a-session`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'tools/list' }),
      },
    ).catch((error: Error) => error)
    assert.ok(
      !(stillServing instanceof Error),
      'the gateway must still answer HTTP after a client disappears, but the ' +
        `connection failed: ${(stillServing as Error).message}. A dropped ` +
        'client took the whole process down.',
    )
    assert.ok(
      stillServing.status >= 400,
      'an unknown session is rejected rather than served',
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
  },
)
