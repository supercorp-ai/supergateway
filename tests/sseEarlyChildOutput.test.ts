import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'

test('SSE gateway starts a child only after a client connects', async (t) => {
  const b = observeGateway(t)
  const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
  await stdioToSse({
    stdioCmd: 'peer --early-output',
    port: 8131,
    baseUrl: '',
    ssePath: '/events',
    messagePath: '/messages',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  })
  assert.equal(b.children.length, 0, 'no session means no child to leak output')
  await b.request('GET', '/events')
  const transport = b.transports.at(-1)!
  const later = { jsonrpc: '2.0', method: 'notifications/later' }
  b.children[0].stdout.emit('data', Buffer.from(JSON.stringify(later) + '\n'))
  assert.deepEqual(
    transport.sent,
    [later],
    'the session receives output from its own child',
  )
})
