import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 18 and
// 20, which the compat job still covers.
import { WebSocket } from 'ws'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * Which client gets what, over WebSocket.
 *
 * The gateway used to share one child between every client and tell them apart
 * by rewriting each request id to `<clientId>:<id>`. That routed replies, but
 * only replies: notifications and the server's own requests carry no client id,
 * so they were broadcast, and the rewriting itself broke string ids (GW-018),
 * the server's requests and cancellation in turn. Each connection now has its
 * own child, as each SSE connection has since #221, and ids pass through
 * unchanged. These tests pin what that design has to keep true.
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
 * Under the old id tunnel, the composite id was taken apart with
 * `parseInt(rawId, 10)`, which assumed the
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

// The other direction. Under the id tunnel a string id was taken for a client
// id and the server's request dropped, and a client's reply reached the child
// as `<clientId>:<id>`, so no server request ever completed.
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

// A cancel names the client's own id. Under the id tunnel the request reached
// the child rewritten, so the cancel named an id the child had never seen and
// the tool ran on.
test(
  'a WebSocket client’s cancel reaches the request it named',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/slow-peer.mjs',
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const client = await connect(port, t)
    const send = (message: object) =>
      client.socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
    const reply = async (id: string) => {
      await gateway.waitFor(() => client.ids().includes(id), `answer ${id}`)
      return client.received
        .map((raw) => JSON.parse(raw))
        .find((m) => m.id === id)
    }
    send({
      id: 'init',
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0.0' },
      },
    })
    await reply('init')
    send({ method: 'notifications/initialized' })
    send({
      id: 'call-A',
      method: 'tools/call',
      params: { name: 'slow', arguments: { ms: 1500 } },
    })
    await delay(300)
    send({
      method: 'notifications/cancelled',
      params: { requestId: 'call-A', reason: 'user stopped it' },
    })
    await delay(300)
    send({
      id: 'status',
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    })
    assert.equal((await reply('status')).result.content[0].text, 'aborted')
  },
)

// The leak itself: under one shared child, a notification had no client to
// route to, so B received A's log messages and progress, though B never sent
// anything. A log line can carry anything a tool prints.
test(
  'a WebSocket client never receives another client’s notifications',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(
      t,
      [
        '--stdio',
        'node tests/helpers/reverse-peer.mjs',
        '--outputTransport',
        'ws',
        '--port',
        String(port),
      ],
      { PROGRESS_SPACING: '1' },
    )
    await gateway.ready()
    const asking = await connect(port, t)
    const bystander = await connect(port, t)
    const send = (message: object) =>
      asking.socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
    send({
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'A', version: '1.0.0' },
      },
    })
    await gateway.waitFor(() => asking.ids().includes(1), 'initialize')
    send({ method: 'notifications/initialized' })
    send({
      id: 2,
      method: 'tools/call',
      params: { name: 'log', arguments: {} },
    })
    send({
      id: 3,
      method: 'tools/call',
      params: {
        name: 'progress',
        arguments: {},
        _meta: { progressToken: 'A' },
      },
    })
    await gateway.waitFor(
      () => asking.ids().includes(2) && asking.ids().includes(3),
      'finish both calls',
    )
    const methods = asking.received.map((raw) => JSON.parse(raw).method)
    assert.equal(
      methods.filter((m) => m === 'notifications/message').length,
      3,
      'the asking client gets its own logs',
    )
    assert.equal(
      methods.filter((m) => m === 'notifications/progress').length,
      3,
      'and its own progress',
    )
    assert.deepEqual(bystander.received, [], 'the bystander gets nothing')
  },
)

// Each connection is its own session with its own server process, so a
// server's state does not carry from one client to the next either.
test(
  'each WebSocket connection gets its own server process',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/slow-peer.mjs',
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const statusOf = async (client: Awaited<ReturnType<typeof connect>>) => {
      const send = (message: object) =>
        client.socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
      send({
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1.0.0' },
        },
      })
      await gateway.waitFor(() => client.ids().includes('init'), 'initialize')
      send({ method: 'notifications/initialized' })
      return send
    }
    const first = await connect(port, t)
    const sendFirst = await statusOf(first)
    sendFirst({
      id: 'slow',
      method: 'tools/call',
      params: { name: 'slow', arguments: { ms: 10 } },
    })
    await gateway.waitFor(() => first.ids().includes('slow'), 'finish')
    const second = await connect(port, t)
    const sendSecond = await statusOf(second)
    sendSecond({
      id: 'status',
      method: 'tools/call',
      params: { name: 'status', arguments: {} },
    })
    await gateway.waitFor(() => second.ids().includes('status'), 'status')
    const status = second.received
      .map((raw) => JSON.parse(raw))
      .find((m) => m.id === 'status')
    assert.equal(
      status.result.content[0].text,
      'none',
      'the second client sees a fresh server, not the first client’s',
    )
  },
)
