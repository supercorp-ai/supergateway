import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

test('WebSocket sends prune stale clients and report each broadcast disconnection once', async (t) => {
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
    removed: string[] = []
  transport.onconnection = (id) => ids.push(id)
  transport.ondisconnection = (id) => removed.push(id)
  await transport.start()
  const direct = new Socket(),
    broadcast = new Socket(),
    healthy = new Socket()
  for (const socket of [direct, broadcast, healthy])
    server!.emit('connection', socket)
  direct.readyState = 3
  await transport.send(
    { jsonrpc: '2.0', id: `${ids[0]}:5`, result: {} },
    `${ids[0]}:5`,
  )
  // map: direct-disconnection
  assert.deepEqual(removed, [ids[0]])
  // The fake socket remains available to the test. Marking it open again
  // distinguishes actual removal from simply skipping a non-open socket.
  direct.readyState = 1
  broadcast.readyState = 3
  const notice = {
    jsonrpc: '2.0' as const,
    method: 'notifications/initialized',
  }
  await transport.broadcast(notice)
  // map: direct-pruned
  assert.deepEqual(direct.sent, [])
  // map: broadcast-disconnection
  assert.deepEqual(removed, [ids[0], ids[1]])
  broadcast.readyState = 1
  await transport.broadcast(notice)
  // map: broadcast-pruned
  assert.deepEqual(
    {
      stale: broadcast.sent,
      removed,
      healthy: healthy.sent.map((s) => JSON.parse(s)),
    },
    { stale: [], removed: [ids[0], ids[1]], healthy: [notice, notice] },
  )
})
