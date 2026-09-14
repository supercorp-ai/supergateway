import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { WebSocket } from 'ws'
import { WebSocketServerTransport } from '../src/server/websocket.js'

test(
  'WebSocket public transport lifecycle detaches handlers and prunes a closing peer',
  { timeout: 10000 },
  async (t) => {
    const server = createServer()
    const transport = new WebSocketServerTransport({ path: '/ws', server })
    const peers: { destroy(): unknown }[] = []
    t.after(async () => {
      for (const peer of peers) peer.destroy()
      await transport.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    await transport.start()
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const port = (server.address() as { port: number }).port
    const received: object[] = []
    transport.onmessage = (message) => received.push(message)
    transport.onmessage = undefined
    const normal = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    peers.push({ destroy: () => normal.terminate() })
    await once(normal, 'open')
    normal.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )
    const pong = once(normal, 'pong')
    normal.ping()
    await pong // ordered protocol barrier: the previous message was processed
    assert.equal(received.length, 0)
    transport.onmessage = (message) => received.push(message)
    normal.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }))
    const nextPong = once(normal, 'pong')
    normal.ping()
    await nextPong
    assert.equal(received.length, 1)

    // Complete a real WebSocket handshake, then hold the TCP write-half open
    // after the peer sends its close response. This deterministically exercises
    // broadcasting during the close handshake, without reaching into internals.
    const closing = connect({ host: '127.0.0.1', port, allowHalfOpen: true })
    peers.push(closing)
    await once(closing, 'connect')
    let headers = ''
    const upgraded = new Promise<void>((resolve) =>
      closing.on('data', (data) => {
        headers += data.toString()
        if (headers.includes('\r\n\r\n')) resolve()
      }),
    )
    closing.write(
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`,
    )
    await upgraded
    assert.match(headers, /^HTTP\/1.1 101/)
    const disconnected: string[] = []
    transport.ondisconnection = (id) => disconnected.push(id)
    // Masked, empty close frame (mask is four zero bytes).
    const ended = once(closing, 'end')
    closing.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
    await ended
    const broadcast = once(normal, 'message')
    await transport.broadcast({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    assert.deepEqual(JSON.parse(String((await broadcast)[0])), {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    assert.equal(
      disconnected.length,
      1,
      'closing peer is pruned while live peer receives broadcast',
    )
    closing.end()
  },
)
