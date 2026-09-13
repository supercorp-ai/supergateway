import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

test('WebSocket transport keeps its client registry without error or disconnection handlers', async (t) => {
  let server: EventEmitter
  class Socket extends EventEmitter {
    static OPEN = 1
    readyState = 1
    sent: string[] = []
    send(value: string) {
      this.sent.push(value)
    }
  }
  t.mock.module('ws', {
    namedExports: {
      WebSocket: Socket,
      WebSocketServer: class extends EventEmitter {
        constructor() {
          super()
          server = this
        }
      },
    },
  })
  const { WebSocketServerTransport } = await import(
    '../src/server/websocket.js'
  )
  const transport = new WebSocketServerTransport({
    path: '/ws',
    server: new EventEmitter() as any,
  })
  const ids: string[] = [],
    delivered: any[] = []
  transport.onconnection = (id) => ids.push(id)
  transport.onmessage = (msg) => delivered.push(msg)
  // onerror and ondisconnection are deliberately left unset: both are optional
  // on the Transport interface, and a host that omits them must still get a
  // working transport rather than a crash or a stale client map.
  await transport.start()
  const direct = new Socket(),
    broadcast = new Socket(),
    healthy = new Socket()
  for (const socket of [direct, broadcast, healthy])
    server!.emit('connection', socket)
  const notice = { jsonrpc: '2.0' as const, method: 'notifications/message' }
  const reaching = (socket: Socket) => socket.sent.map((s) => JSON.parse(s))

  healthy.emit('message', Buffer.from('{"jsonrpc":"2.0","method":"ping"}'))
  healthy.emit('message', Buffer.from('not json'))
  healthy.emit('error', new Error('socket failed'))
  // map: unhandled-parse-failure-contained
  assert.deepEqual(
    delivered,
    [{ jsonrpc: '2.0', method: 'ping' }],
    'a malformed frame and a socket error are absorbed with no error handler, and neither reaches onmessage nor stops later frames',
  )

  direct.readyState = 3
  await transport.send(
    { jsonrpc: '2.0', id: `${ids[0]}:5`, result: {} },
    `${ids[0]}:5`,
  )
  direct.readyState = 1
  broadcast.readyState = 3
  await transport.broadcast(notice)
  broadcast.readyState = 1
  healthy.emit('close')
  await transport.broadcast(notice)
  // map: pruned-without-disconnection-handler
  assert.deepEqual(
    {
      direct: reaching(direct),
      broadcast: reaching(broadcast),
      healthy: reaching(healthy),
    },
    { direct: [], broadcast: [], healthy: [notice] },
    'a client dropped by a targeted send, by a broadcast or by closing is removed from the registry even with no disconnection handler, so reopening its socket does not resume delivery',
  )
})
