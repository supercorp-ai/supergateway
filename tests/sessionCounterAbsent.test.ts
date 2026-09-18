import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'

/**
 * A stateful gateway only builds a `SessionAccessCounter` when it has a
 * timeout to enforce, so every call through it is written `sessionCounter?.`.
 * The CLI now always supplies a timeout — a session owns a child process and
 * "never expire" leaked one per unclean disconnect — which left the absent
 * half of those optional calls unexercised. The gateway still accepts
 * `sessionTimeout: null` and six test files drive it that way, so the branch is
 * reachable through the module's own contract and is covered here rather than
 * removed.
 */
test('a stateful gateway with no session timeout serves a second request on the same session', async (t) => {
  const b = observeGateway(t)
  const { stdioToStatefulStreamableHttp } = await import(
    '../src/gateways/stdioToStatefulStreamableHttp.js'
  )
  await stdioToStatefulStreamableHttp({
    stdioCmd: 'controlled-peer',
    port: 0,
    streamableHttpPath: '/mcp',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
    sessionTimeout: null,
    protocolVersion: '2024-11-05',
  })

  await b.request('POST', '/mcp', { body: initialize() })
  const sessionId = b.transports.at(-1)!.sessionId
  assert.ok(sessionId, 'the initialize request established a session')
  const opened = b.transports.length

  // Reusing the session takes the branch that increments the counter. With no
  // timeout there is no counter, and the optional call has to be a no-op rather
  // than a crash.
  const { res } = await b.request('POST', '/mcp', {
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    headers: { 'mcp-session-id': sessionId },
  })

  assert.equal(
    b.transports.length,
    opened,
    'the second request reused the session rather than opening another',
  )

  // Ending the response releases the access the request took. Without a
  // counter there is nothing to release, and that too has to be a no-op: the
  // handler runs on every response, so a crash here would end every request.
  res.emit('finish')
  assert.deepEqual(
    b.info.at(-1),
    ['Response finished', sessionId],
    'the response-end handler ran to completion with no counter to decrement',
  )

  // GET and DELETE share a second handler with its own pair of counter calls.
  // Both have to tolerate the counter's absence too; a throw here would end
  // every stream a client opens.
  const stream = await b.request('GET', '/mcp', {
    headers: { 'mcp-session-id': sessionId },
  })
  stream.res.emit('finish')
  assert.deepEqual(
    b.info.at(-1),
    ['Response finished', sessionId],
    'the shared GET/DELETE handler also survives having no counter',
  )
})
