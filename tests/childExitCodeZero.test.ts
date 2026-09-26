import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'

// SSE and WebSocket children are scoped to one connection each, so a child's
// exit must not stop the gateway. (WebSocket's is in websocketObservedEvents.)

test('SSE gateway stays up when a session child exits 0', async (t) => {
  const b = observeGateway(t)
  const codes: unknown[] = []
  const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
  await stdioToSse({
    stdioCmd: 'peer --clean-exit',
    port: 8143,
    baseUrl: '',
    ssePath: '/events',
    messagePath: '/messages',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  })
  t.mock.method(process, 'exit', (code?: any): never => {
    codes.push(code)
    return undefined as never
  })
  const first = await b.request('GET', '/events')
  const firstId = b.transports[0].sessionId!
  b.children[0].emit('exit', 0, null)
  await new Promise((resolve) => setImmediate(resolve))
  // map: sse-clean-child-exit-code
  assert.deepEqual(
    codes,
    [],
    'the session child finishing must not terminate other gateway sessions',
  )
  assert.deepEqual(b.errors.at(-1), [
    `Child exited (session ${firstId}): code=0, signal=null`,
  ])
  assert.equal(b.serverCloses.length, 1)
  await b.request('GET', '/events')
  assert.equal(b.children.length, 2, 'a new session still starts')
  first.req.emit('close')
})
