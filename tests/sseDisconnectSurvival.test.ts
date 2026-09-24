import test from 'node:test'
import assert from 'node:assert/strict'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

const noisyPeerCommand = 'node tests/helpers/noisy-mcp-server.js stdio'

/**
 * A client that vanishes must not be able to take the gateway down with it.
 *
 * A dropped client owns a child with a delayed reply in flight. The session
 * must close and reap that child while the gateway remains available.
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

    // The session's child is stopped before its delayed reply can reach anyone.
    await gateway.waitFor(
      () => /Child exited \(session .*signal=SIGTERM/.test(gateway.output()),
      'stop the departed session’s child',
    )

    // Ask HTTP for a reply so liveness is observed after child teardown.
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
