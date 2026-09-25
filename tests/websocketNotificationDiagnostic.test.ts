import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

test('a client notification is relayed unchanged and not printed', async (t) => {
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
  let clientId = ''
  transport.onconnection = (id) => (clientId = id)
  await transport.start()
  const socket = new EventEmitter()
  server!.emit('connection', socket)
  const message = { jsonrpc: '2.0', method: 'notifications/initialized' }
  socket.emit('message', Buffer.from(JSON.stringify(message)))
  // map: notification-log
  // Relayed unchanged, and not printed: the gateway logs traffic through its
  // logger, which honours --logLevel. A console.log here printed every client
  // notification even with `--logLevel none`.
  assert.deepEqual({ logs, received }, { logs: [], received: [message] })

  // A cancel names the client's request id, which reached the child tunnelled
  // as `<clientId>:<id as JSON>`, so the cancel is rewritten to match. Before,
  // it reached the child naming an id it had never seen, and cancelled nothing.
  const cancel = (params?: object) => ({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    ...(params ? { params } : {}),
  })
  for (const sent of [
    cancel({ requestId: 'call-A', reason: 'stop' }),
    cancel({ requestId: 7 }),
    cancel(),
    { jsonrpc: '2.0', result: 'no id, no method' },
  ])
    socket.emit('message', Buffer.from(JSON.stringify(sent)))
  assert.deepEqual(received.slice(1), [
    cancel({ requestId: `${clientId}:"call-A"`, reason: 'stop' }),
    cancel({ requestId: `${clientId}:7` }),
    cancel(),
    { jsonrpc: '2.0', result: 'no id, no method' },
  ])
})
