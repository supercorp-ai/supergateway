import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// The WebSocket endpoint in isolation: a registry of connected clients that
// passes messages through unchanged and addresses them by client. The gateway
// gives each connection its own child, so nothing here rewrites ids.
test('WebSocket transport passes messages through per client and reports each ending', async (t) => {
  let server: FakeServer
  let upgraded: unknown
  class FakeServer extends EventEmitter {
    closed = false
    constructor(public options: unknown) {
      super()
      server = this
    }
    close(callback: () => void) {
      this.closed = true
      callback()
    }
    upgrades: unknown[][] = []
    // `ws` checks the request, then hands over the socket it upgraded.
    handleUpgrade(
      req: unknown,
      socket: unknown,
      head: unknown,
      done: (ws: unknown) => void,
    ) {
      this.upgrades.push([req, socket, head])
      done(upgraded)
    }
  }
  class FakeSocket extends EventEmitter {
    static OPEN = 1
    readyState = FakeSocket.OPEN
    sent: string[] = []
    closedWith: unknown[] = []
    send(payload: string) {
      this.sent.push(payload)
    }
    close(...args: unknown[]) {
      this.closedWith = args
    }
  }
  t.mock.module('ws', {
    namedExports: { WebSocket: FakeSocket, WebSocketServer: FakeServer },
  })
  const { WebSocketServerTransport } =
    await import('../src/server/websocket.js')
  const events: unknown[][] = []
  const transport = new WebSocketServerTransport(
    { path: '/wire' },
    {
      onconnection: (id) => events.push(['connect', id]),
      onmessage: (message, id) => events.push(['message', message, id]),
      ondisconnection: (id) => events.push(['disconnect', id]),
      onerror: (error) => events.push(['error', error.message]),
    },
  )
  // Not bound to an HTTP server: the gateway hands it its upgrades, so
  // several can share one port.
  assert.deepEqual(server!.options, { path: '/wire', noServer: true })
  transport.start()

  const first = new FakeSocket(),
    second = new FakeSocket()
  // map: an upgrade handed over becomes a connection
  const upgrade = [{ url: '/wire' }, { socket: 1 }, Buffer.from('head')]
  upgraded = first
  transport.handleUpgrade(
    ...(upgrade as Parameters<typeof transport.handleUpgrade>),
  )
  assert.deepEqual(server!.upgrades, [upgrade])
  server!.emit('connection', second)
  const [a, b] = events.map((event) => event[1] as string)
  // map: connections
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f-]{27}$/)
  assert.notEqual(a, b)

  // Requests, string ids, cancels and replies all arrive exactly as sent.
  const frames = [
    { jsonrpc: '2.0', id: 'req-abc', method: 'tools/list' },
    {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'req-abc' },
    },
    { jsonrpc: '2.0', id: 0, result: {} },
  ]
  for (const frame of frames)
    first.emit('message', Buffer.from(JSON.stringify(frame)))
  first.emit('message', Buffer.from('{broken'))
  first.emit('error', new Error('peer reset'))
  // map: messages
  assert.deepEqual(events.slice(2), [
    ...frames.map((frame) => ['message', frame, a]),
    ['error', events[5]![1]],
    ['error', 'peer reset'],
  ])
  assert.match(String(events[5]![1]), /^Failed to parse message:/)

  // map: send addresses one client
  transport.send({ jsonrpc: '2.0', id: 'req-abc', result: {} }, a)
  assert.deepEqual(first.sent, [
    JSON.stringify({ jsonrpc: '2.0', id: 'req-abc', result: {} }),
  ])
  assert.deepEqual(second.sent, [])
  // A client that is closing, or unknown, is skipped.
  second.readyState = 2
  transport.send({ jsonrpc: '2.0', method: 'ping' }, b)
  transport.send({ jsonrpc: '2.0', method: 'ping' }, 'nobody')
  assert.deepEqual(second.sent, [])

  // map: disconnect closes one client's socket
  transport.disconnect(b, 'MCP server process exited')
  transport.disconnect('nobody', 'ignored')
  assert.deepEqual(second.closedWith, [1011, 'MCP server process exited'])
  assert.deepEqual(first.closedWith, [])

  // map: a closed socket is forgotten and reported once
  events.length = 0
  second.emit('close')
  transport.send({ jsonrpc: '2.0', method: 'ping' }, b)
  assert.deepEqual(events, [['disconnect', b]])

  await transport.close()
  // map: close
  assert.equal(server!.closed, true)
  transport.send({ jsonrpc: '2.0', method: 'ping' }, a)
  assert.equal(first.sent.length, 1, 'nothing is sent after close')
})
