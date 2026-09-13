import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

test('WebSocket notification diagnostics preserve the received message', async (t) => {
  let server: EventEmitter
  t.mock.module('ws', {
    namedExports: {
      WebSocket: class {},
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
  const logs: unknown[][] = [],
    received: unknown[] = []
  t.mock.method(console, 'log', (...args: unknown[]) => logs.push(args))
  transport.onmessage = (message) => received.push(message)
  await transport.start()
  const socket = new EventEmitter()
  server!.emit('connection', socket)
  const message = { jsonrpc: '2.0', method: 'notifications/initialized' }
  socket.emit('message', Buffer.from(JSON.stringify(message)))
  // map: notification-log
  assert.deepEqual(
    { logs, received },
    { logs: [['Broadcast message:', message]], received: [message] },
  )
})
