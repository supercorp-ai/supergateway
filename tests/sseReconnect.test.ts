import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

const noisyPeerCommand = 'node tests/helpers/noisy-mcp-server.js stdio'

/**
 * Reconnecting is the ordinary case, not an edge one: an MCP client that loses
 * its stream reopens it, and Inspector opens and closes several while a user
 * clicks around. Nothing in the suite covered it.
 *
 * This is GW-017 again — one `Server` per process, `server.connect()` per
 * connection — but it is worth its own test because the consequence is
 * different and worse than the concurrent case. Measured on SDK 1.30 with a
 * clean disconnect first:
 *
 *   connect #1: status=200 endpoint=yes
 *   gateway logged close: true
 *   connect #2: FAILED — other side closed
 *   gateway alive: false
 *   post-close error in log: Already connected
 *
 * So from 1.26 the gateway serves one client per *process lifetime*, and the
 * attempt to reconnect does not merely fail — the `Already connected` throw
 * lands in an async Express handler with nothing to catch it, and the rejection
 * kills the gateway. That is #154's shape, and the mechanism ESLint's
 * `no-misused-promises` flags on the SSE route.
 *
 * Fixed by giving each session its own `Server`, so nothing is ever asked to
 * connect twice. The SDK's guard was right; the gateway was reusing one
 * `Protocol` for every connection.
 */
test(
  'an SSE client can reconnect after disconnecting',
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

    const first = new AbortController()
    const original = await connect(first.signal)
    first.abort()
    await gateway.waitFor(
      () => /SSE connection closed/.test(gateway.output()),
      'notice the client leaving',
    )

    // The gateway now holds no sessions. Reconnecting must work.
    const reconnected = await connect()
    assert.notEqual(
      reconnected.endpoint,
      original.endpoint,
      'the reconnection is a new session, not the old one handed back',
    )

    // And the reconnected client must actually be served, not just accepted.
    await fetch(`http://127.0.0.1:${port}${reconnected.endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 31, method: 'tools/list' }),
    })
    await gateway.waitFor(
      () => reconnected.frames.some((frame) => frame.includes('"id":31')),
      'answer the reconnected client',
    )

    assert.equal(
      gateway.child.exitCode,
      null,
      'the gateway survives a client reconnecting',
    )
  },
)
