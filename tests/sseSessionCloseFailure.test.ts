import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'

/**
 * Its own file, like the repo's other mocked-gateway tests: `t.mock.module` is
 * per test but the module cache is not, so a second import of the same gateway
 * in one file returns the instance bound to the first test's mocks.
 *
 * Ending an SSE session closes that session's own `Server`. `close()` is async,
 * so it reports failure by rejecting, and a rejection with nobody listening is
 * how cluster A killed the process. The session is removed from the registry
 * before the close is attempted, so a failing close costs the gateway a log
 * line and nothing else — which is what this asserts.
 */
test('a failing session close is reported and does not end the gateway', async (t) => {
  const b = observeGateway(t)
  const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
  await stdioToSse({
    stdioCmd: 'peer --close-failure',
    port: 8191,
    baseUrl: '',
    ssePath: '/events',
    messagePath: '/messages',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  })

  const fault = new Error('server close refused')
  b.failServerClose(fault)

  const { req } = await b.request('GET', '/events')
  const transport = b.transports.at(-1)!
  const sessionId = transport.sessionId!
  req.emit('close')
  // The rejection is handled a microtask later, not synchronously.
  await Promise.resolve()
  await Promise.resolve()

  assert.deepEqual(b.errors.at(-1), [
    `Failed to close session ${sessionId}:`,
    fault,
  ])

  // The session is gone regardless: removal happens before the close is
  // attempted, so a server that cannot close cannot strand a session either.
  const rejected = await b.request('POST', '/messages', {
    query: { sessionId },
    body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  })
  assert.deepEqual(
    { code: rejected.res.code, body: rejected.res.body },
    { code: 503, body: `No active SSE connection for session ${sessionId}` },
  )
})
