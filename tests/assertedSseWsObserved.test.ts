import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'

// The stdio→SSE diagnostic for a stream the SDK could not start. A real
// gateway cannot be made to fail there: the SDK's `start` only writes the
// stream's head, which a live response always accepts. So this drives the
// real gateway code with the observed transport, which can throw on connect.

test('an SSE stream that fails to start is reported with its cause', async (t) => {
  const b = observeGateway(t)
  const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
  await stdioToSse({
    stdioCmd: 'peer',
    port: 8191,
    baseUrl: '',
    ssePath: '/sse',
    messagePath: '/message',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  })
  const cause = Error('transport start failed')
  b.onConnect(() => {
    throw cause
  })
  const errorsBefore = b.errors.length
  const failed = await b.request('GET', '/sse')
  // map: the client is refused, and no child is started for it
  assert.equal(failed.res.code, 500)
  assert.equal(b.children.length, 0)
  // map: the operator sees why, once, with the SDK's own error
  assert.deepEqual(b.errors.slice(errorsBefore), [
    ['Failed to open SSE session:', cause],
  ])
})
