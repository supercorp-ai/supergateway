import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'

test('SSE connect races with disconnect and shutdown without spawning children', async (t) => {
  const b = observeGateway(t)
  b.onConnect((transport) => transport.response.destroy())
  const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
  await stdioToSse({
    stdioCmd: 'peer',
    port: 8128,
    baseUrl: '',
    ssePath: '/sse',
    messagePath: '/message',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  })
  await b.request('GET', '/sse')
  assert.equal(b.children.length, 0)
  assert.equal(b.serverCloses.length, 1)
  const rejected = await b.request('POST', '/message', {
    query: { sessionId: b.transports[0].sessionId },
    body: { jsonrpc: '2.0', id: 1, method: 'ping' },
  })
  assert.equal(rejected.res.code, 503)

  b.onConnect(() => {
    throw Error('transport start failed')
  })
  const failed = await b.request('GET', '/sse')
  assert.equal(failed.res.code, 500)
  assert.equal(b.children.length, 0)
  assert.equal(b.serverCloses.length, 2)

  b.onConnect(async () => b.signals[0].cleanup())
  await b.request('GET', '/sse')
  assert.equal(b.children.length, 0)
  assert.equal(b.serverCloses.length, 3)
  const after = await b.request('GET', '/sse')
  assert.equal(after.res.code, 503)
  assert.equal(b.children.length, 0)
})
