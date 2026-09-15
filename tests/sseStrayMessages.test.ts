import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * A POST to the message path that belongs to no live SSE session.
 *
 * Raised by @cosmic-fire-eng on #112 as a trigger for the same crash that
 * reconnecting caused on 3.4.3 — "any POST to /message that does not belong to
 * an established SSE session". Worth pinning rather than assuming, because a
 * gateway on a public port receives these constantly: a client that reconnects
 * with a stale session id, a health checker, a scanner.
 *
 * Measured on this build against SDK 1.30: both shapes are refused cleanly and
 * the process stays up. The test is here so that stays true.
 */
test(
  'a message for no live session is refused without ending the gateway',
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

    const post = (query: string) =>
      fetch(`http://127.0.0.1:${port}/message${query}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        signal: AbortSignal.timeout(5000),
      })

    const unknown = await post('?sessionId=does-not-exist')
    assert.equal(unknown.status, 503)
    assert.equal(
      await unknown.text(),
      'No active SSE connection for session does-not-exist',
    )

    const missing = await post('')
    assert.equal(missing.status, 400)
    assert.equal(await missing.text(), 'Missing sessionId parameter')

    // Still serving afterwards, which is the part that was in doubt.
    const opened = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { accept: 'text/event-stream' },
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(opened.status, 200)
    await opened.body!.cancel()
    assert.equal(gateway.child.exitCode, null, 'the gateway is still running')
  },
)
