import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayTimeout,
  launchGateway,
  peerCommand,
  unusedPort,
  requestTimeout,
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
  { timeout: gatewayTimeout(30000) },
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
        signal: AbortSignal.timeout(requestTimeout(5000)),
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
      signal: AbortSignal.timeout(requestTimeout(5000)),
    })
    assert.equal(opened.status, 200)
    await opened.body!.cancel()
    assert.equal(gateway.child.exitCode, null, 'the gateway is still running')
  },
)

/**
 * A session id that names a member every plain object inherits is a session
 * id like any other: unknown, so the same 503, and the gateway serves on.
 */
test(
  'a session id naming an inherited object member is an unknown session',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(port),
    ])
    await gateway.ready()

    for (const sessionId of [
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'valueOf',
    ]) {
      // A browser can send this one without a preflight.
      const refused = await fetch(
        `http://127.0.0.1:${port}/message?sessionId=${sessionId}`,
        {
          method: 'POST',
          headers: { 'content-type': 'text/plain' },
          body: 'x',
          signal: AbortSignal.timeout(requestTimeout(5000)),
        },
      )
      assert.equal(refused.status, 503, sessionId)
      assert.equal(
        await refused.text(),
        `No active SSE connection for session ${sessionId}`,
      )
    }

    const opened = await fetch(`http://127.0.0.1:${port}/sse`, {
      headers: { accept: 'text/event-stream' },
      signal: AbortSignal.timeout(requestTimeout(5000)),
    })
    assert.equal(opened.status, 200)
    await opened.body!.cancel()
    assert.equal(gateway.child.exitCode, null, 'the gateway is still running')
  },
)
