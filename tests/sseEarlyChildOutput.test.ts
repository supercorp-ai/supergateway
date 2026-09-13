import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'

test('SSE gateway drops child output produced before any client connects', async (t) => {
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
  const early = { jsonrpc: '2.0', method: 'notifications/early' }
  b.children[0].stdout.emit('data', Buffer.from(JSON.stringify(early) + '\n'))
  // map: early-output-parsed
  assert.deepEqual(
    { last: b.info.at(-1), sessions: b.transports.length },
    { last: ['Child → SSE:', early], sessions: 0 },
    'output arriving with no session open is still parsed and logged, and there is no session to fan it out to',
  )
  await b.request('GET', '/events')
  const transport = b.transports.at(-1)!
  const later = { jsonrpc: '2.0', method: 'notifications/later' }
  b.children[0].stdout.emit('data', Buffer.from(JSON.stringify(later) + '\n'))
  // map: no-replay-on-connect
  assert.deepEqual(
    transport.sent,
    [later],
    'a client that connects afterwards receives only what the child emits from then on; the earlier message is dropped, not buffered and replayed',
  )
})
