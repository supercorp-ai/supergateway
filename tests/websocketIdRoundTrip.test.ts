import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// GW-018: the transport rewrites each request id to `<clientId>:<id>` so a reply
// can find its client, and must restore the id with its original type. It used
// `parseInt`, which turned every string id into NaN, sent as null.
test('GW-018: composite ids restore the client’s id with its type', async (t) => {
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
  const received: any[] = []
  let clientId = ''
  transport.onconnection = (id) => (clientId = id)
  transport.onmessage = (message) => received.push(message)
  await transport.start()
  const socket = new Socket()
  server!.emit('connection', socket)

  for (const id of ['req-abc', 7, 'with:colon'])
    socket.emit(
      'message',
      Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method: 'ping' })),
    )
  for (const message of received)
    await transport.send(
      { jsonrpc: '2.0', id: message.id, result: {} },
      message.id,
    )
  assert.deepEqual(
    socket.sent.map((frame) => JSON.parse(frame).id),
    ['req-abc', 7, 'with:colon'],
    'each reply carries exactly the id its request did',
  )

  await transport.send(
    { jsonrpc: '2.0', id: 'ignored', result: {} },
    `${clientId}:plain`,
  )
  assert.equal(
    JSON.parse(socket.sent.at(-1)!).id,
    'plain',
    'a suffix that is not JSON is kept as the string it was',
  )
})
