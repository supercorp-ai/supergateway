import test from 'node:test'
import assert from 'node:assert/strict'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 18 and
// 20, which the compat job still covers.
import { WebSocket } from 'ws'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * The WebSocket gateway is the one bridge in this repository that already
 * routes a reply to the client that asked for it, and it is worth understanding
 * before GW-017 is fixed elsewhere: it is a working reference for the
 * "route by request id" option, implemented in `src/server/websocket.ts`.
 *
 * On the way in, the transport rewrites the JSON-RPC id to
 * `<clientId>:<originalId>`, with the original id written as JSON. The child
 * echoes that composite back, and the send path splits it at the first colon,
 * restores the original id and delivers to that one client. Client identity is
 * tunnelled through the id field.
 *
 * Neat, and it had a sharp edge — see GW-018 below.
 */
async function connect(port: number, t: { after: (fn: () => void) => void }) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
  const received: string[] = []
  socket.on('message', (data: Buffer) => {
    received.push(data.toString('utf8'))
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', (error: Error) => reject(error))
  })
  t.after(() => socket.close())
  return {
    socket,
    received,
    ids: () => received.map((raw) => JSON.parse(raw).id),
  }
}

const launch = async (t: Parameters<typeof launchGateway>[0]) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--outputTransport',
    'ws',
    '--port',
    String(port),
  ])
  await gateway.ready()
  return { port, gateway }
}

// The property GW-017 breaks for SSE. It holds here, and it must keep holding:
// whatever fixes SSE should not regress the transport that already gets it
// right.
test(
  'a WebSocket client does not receive another client’s replies',
  { timeout: 30000 },
  async (t) => {
    const { port, gateway } = await launch(t)
    const asking = await connect(port, t)
    const bystander = await connect(port, t)

    asking.socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 4242, method: 'tools/list' }),
    )
    await gateway.waitFor(
      () => asking.ids().includes(4242),
      'deliver the reply to the client that asked',
    )

    assert.deepEqual(
      asking.ids(),
      [4242],
      'the asking client receives its own reply, with its own id',
    )
    assert.deepEqual(
      bystander.received,
      [],
      'a client that sent nothing receives nothing',
    )
  },
)

/**
 * GW-018, fixed: a string JSON-RPC id came back as null.
 *
 * The composite id was taken apart with `parseInt(rawId, 10)`, which assumed the
 * original id was a number. JSON-RPC 2.0 allows a string, and so does MCP.
 * `parseInt('req-abc', 10)` is NaN, and `JSON.stringify` writes NaN as null, so
 * the client is sent `"id": null` for a request it labelled `"req-abc"` and can
 * never match the reply to it. Measured:
 *
 *   client A sent id: "req-abc"
 *   A received id: null  (type object)
 *
 * Numeric ids are unaffected, which is why nothing caught this: the SDK's own
 * client numbers its requests. A client using string or UUID ids gets replies
 * it cannot correlate, and every request appears to hang.
 */
test(
  'GW-018: a WebSocket client’s string request id survives the round trip',
  { timeout: 30000 },
  async (t) => {
    const { port, gateway } = await launch(t)
    const client = await connect(port, t)

    client.socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 'req-abc', method: 'tools/list' }),
    )
    await gateway.waitFor(
      () => client.received.length > 0,
      'answer the request at all',
    )

    assert.equal(
      client.ids()[0],
      'req-abc',
      'the reply carries the id the client sent, not null',
    )
  },
)

// The other direction. A request of the server's own is broadcast, and the
// client's reply reaches the child with the child's id, not a tunnelled one.
// Before, a string id was taken for a client id and the request dropped, and a
// reply carried `<clientId>:<id>`, so no server request ever completed.
test(
  'a server request with a string id reaches the client and its reply reaches the server',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/string-id-reverse-peer.mjs',
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const client = await connect(port, t)
    client.socket.on('message', (data: Buffer) => {
      const message = JSON.parse(data.toString('utf8'))
      if (message.method === 'ping')
        client.socket.send(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }),
        )
    })

    client.socket.send(
      JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }),
    )
    await gateway.waitFor(
      () => client.ids().includes(7),
      'complete the request once the server’s ping is answered',
    )
    assert.deepEqual(
      client.received.map((raw) => JSON.parse(raw)),
      [
        { jsonrpc: '2.0', id: 'srv-ping', method: 'ping' },
        { jsonrpc: '2.0', id: 7, result: { pingAnswered: true } },
      ],
    )
  },
)
