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

  const closeError = Error('close failed')
  b.failServerClose(closeError)
  b.onConnect((transport) => {
    transport.response.headersSent = true
    throw Error('transport failed after headers')
  })
  const failedAfterHeaders = await b.request('GET', '/sse')
  assert.equal(failedAfterHeaders.res.destroyed, true)
  assert.deepEqual(b.errors.at(-1), [
    'Failed to close rejected SSE session:',
    closeError,
  ])

  b.onConnect((transport) => transport.response.destroy())
  await b.request('GET', '/sse')
  assert.deepEqual(b.errors.at(-1), [
    'Failed to close abandoned SSE session:',
    closeError,
  ])
  b.failServerClose(null)

  b.onConnect((transport) => {
    transport.response.writableEnded = true
  })
  await b.request('GET', '/sse')
  assert.equal(b.children.length, 0, 'an already-ended response owns no child')

  b.onConnect(null)
  const crashed = await b.request('GET', '/sse')
  const crashedId = b.transports.at(-1)!.sessionId!
  const childError = Error('spawn failed')
  b.children.at(-1)!.emit('error', childError)
  assert.deepEqual(b.errors.at(-1), [
    `Child failure (session ${crashedId}):`,
    childError,
  ])
  const stale = await b.request('POST', '/message', {
    query: { sessionId: crashedId },
    body: { jsonrpc: '2.0', id: 2, method: 'ping' },
  })
  assert.equal(stale.res.code, 503)
  crashed.req.emit('close')

  await b.request('GET', '/sse')
  const stdinId = b.transports.at(-1)!.sessionId!
  const endedTransport = b.transports.at(-1)!
  b.children
    .at(-1)!
    .stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":3,"result":{}}\n'))
  assert.equal(endedTransport.sent.length, 1)
  const stdinError = Error('broken pipe')
  b.children.at(-1)!.stdin.emit('error', stdinError)
  assert.deepEqual(b.errors.at(-1), [
    `Child stdin failure (session ${stdinId}):`,
    stdinError,
  ])
  // A buffered reply can arrive after the session has been removed. It must
  // never reach a closed SSE transport.
  const sentBeforeLateReply = endedTransport.sent.length
  b.children
    .at(-1)!
    .stdout.emit('data', Buffer.from('{"jsonrpc":"2.0","id":4,"result":{}}\n'))
  assert.equal(endedTransport.sent.length, sentBeforeLateReply)

  b.onConnect(async () => b.signals[0].cleanup())
  await b.request('GET', '/sse')
  assert.equal(b.children.length, 2)
  assert.equal(b.serverCloses.length, 8)
  const after = await b.request('GET', '/sse')
  assert.equal(after.res.code, 503)
  assert.equal(b.children.length, 2)
})
