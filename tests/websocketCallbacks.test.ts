import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

test('WebSocket transport correlates callbacks, reports errors and clears closed clients', async (t) => {
  let socketServer: FakeServer
  class FakeServer extends EventEmitter {
    constructor(public options: unknown) {
      super()
      socketServer = this
    }
    close(callback: () => void) {
      callback()
    }
  }
  class FakeSocket extends EventEmitter {
    static OPEN = 1
    readyState = FakeSocket.OPEN
    sent: string[] = []
    send(payload: string) {
      this.sent.push(payload)
    }
  }
  t.mock.module('ws', {
    namedExports: { WebSocket: FakeSocket, WebSocketServer: FakeServer },
  })
  const { WebSocketServerTransport } = await import(
    '../src/server/websocket.js'
  )
  const server = new EventEmitter()
  const transport = new WebSocketServerTransport({
    path: '/wire',
    server: server as any,
  })
  const connected: string[] = [],
    disconnected: string[] = [],
    received: any[] = [],
    errors: Error[] = []
  transport.onconnection = (id) => connected.push(id)
  transport.ondisconnection = (id) => disconnected.push(id)
  transport.onmessage = (message) => received.push(message)
  transport.onerror = (error) => errors.push(error)
  t.mock.method(console, 'log', () => {})
  await transport.start()
  assert.deepEqual(socketServer!.options, { path: '/wire', server })
  const first = new FakeSocket(),
    second = new FakeSocket()
  socketServer!.emit('connection', first)
  socketServer!.emit('connection', second)
  assert.equal(connected.length, 2)
  assert.notEqual(connected[0], connected[1])
  assert.match(connected[0], /^[0-9a-f]{8}-[0-9a-f-]{27}$/)
  first.emit(
    'message',
    Buffer.from('{"jsonrpc":"2.0","id":17,"method":"ping"}'),
  )
  assert.deepEqual(received.pop(), {
    jsonrpc: '2.0',
    id: `${connected[0]}:17`,
    method: 'ping',
  })
  second.emit(
    'message',
    Buffer.from('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
  )
  assert.deepEqual(received.pop(), {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })
  await transport.send(
    { jsonrpc: '2.0', id: `${connected[0]}:17`, result: {} },
    `${connected[0]}:17`,
  )
  assert.deepEqual(
    first.sent.map((text) => JSON.parse(text)),
    [{ jsonrpc: '2.0', id: 17, result: {} }],
  )
  assert.deepEqual(second.sent, [])
  first.emit('message', Buffer.from('{broken'))
  assert.match(errors[0].message, /^Failed to parse message:/)
  const error = new Error('peer disconnected')
  first.emit('error', error)
  assert.equal(errors[1], error)
  first.emit('close')
  assert.deepEqual(disconnected, [connected[0]])
  await transport.broadcast({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })
  assert.equal(first.sent.length, 1)
  assert.deepEqual(
    second.sent.map((text) => JSON.parse(text)),
    [{ jsonrpc: '2.0', method: 'notifications/initialized' }],
  )
  await transport.close()
  await transport.broadcast({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
  })
  assert.equal(second.sent.length, 1, 'close clears every remaining client')
})
