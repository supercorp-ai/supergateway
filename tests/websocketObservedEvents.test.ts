import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'

test('WebSocket gateway gives each connection its own child and routes to that client only', async (t) => {
  const b = observeGateway(t)
  let handlers: any
  const sent: any[][] = [],
    disconnected: any[][] = []
  class Transport {
    constructor(_options: unknown, h: unknown) {
      handlers = h
    }
    start() {}
    send(...args: any[]) {
      sent.push(args)
    }
    disconnect(...args: any[]) {
      disconnected.push(args)
    }
    async close() {}
  }
  t.mock.module(new URL('../src/server/websocket.js', import.meta.url).href, {
    namedExports: { WebSocketServerTransport: Transport },
  })
  t.mock.module('http', {
    namedExports: {
      createServer: () => ({
        listen(port: number, callback: () => void) {
          b.listens.push(port)
          callback()
        },
      }),
    },
  })
  const { stdioToWs } = await import('../src/gateways/stdioToWs.js')
  await stdioToWs({
    stdioCmd: 'peer --ws-test',
    port: 8141,
    messagePath: '/wire',
    logger: b.logger,
    corsOrigin: '*',
    healthEndpoints: ['/health'],
  })
  // map: startup
  assert.deepEqual(b.info, [
    ['  - port: 8141'],
    ['  - stdio: peer --ws-test'],
    ['  - messagePath: /wire'],
    ['  - CORS: enabled ("*")'],
    ['  - Health endpoints: /health'],
    ['Listening on port 8141'],
    ['WebSocket endpoint: ws://localhost:8141/wire'],
  ])
  // map: setup — no child until a client connects
  assert.deepEqual(
    {
      spawns: b.spawns,
      listens: b.listens,
      cors: b.corsOptions,
      routes: [...b.routes.keys()],
    },
    {
      spawns: [],
      listens: [8141],
      cors: [{ origin: '*' }],
      routes: ['GET /health'],
    },
  )
  const health = await b.request('GET', '/health')
  // map: health
  assert.deepEqual(
    { code: health.res.code, body: health.res.body },
    { code: 200, body: 'ok' },
  )

  handlers.onconnection('client-A')
  handlers.onconnection('client-B')
  // map: one child per connection
  assert.equal(b.spawns.length, 2)
  assert.deepEqual(b.spawns[0], [
    'peer --ws-test',
    { shell: true, detached: process.platform !== 'win32' },
  ])
  const [childA, childB] = b.children

  // Ids are not rewritten: each child serves one client.
  const request = { jsonrpc: '2.0', id: 9, method: 'ping' }
  handlers.onmessage(request, 'client-A')
  // map: request
  assert.deepEqual(
    { a: childA.writes, b: childB.writes, log: b.info.at(-1) },
    {
      a: [JSON.stringify(request) + '\n'],
      b: [],
      log: [`WebSocket → Child (client client-A): ${JSON.stringify(request)}`],
    },
  )

  // Everything a child says goes to its own client: replies, notifications
  // and the server's own requests alike.
  const reply = { jsonrpc: '2.0', id: 9, result: {} }
  const log = { jsonrpc: '2.0', method: 'notifications/message', params: {} }
  childA.stdout.emit(
    'data',
    Buffer.from(
      '\n \n' + JSON.stringify(reply) + '\n' + JSON.stringify(log) + '\n',
    ),
  )
  // map: routed to the owner
  assert.deepEqual(sent, [
    [reply, 'client-A'],
    [log, 'client-A'],
  ])

  childA.stdout.emit('data', Buffer.from('bad-json\n'))
  childA.stderr.emit('data', Buffer.from('socket warning\n'))
  // map: peer-diagnostics
  assert.deepEqual(
    { error: b.errors.at(-1), info: b.info.at(-1) },
    {
      error: ['Child non-JSON (client client-A): bad-json'],
      info: ['Child stderr (client client-A): socket warning\n'],
    },
  )

  handlers.onerror(new Error('frame rejected'))
  // map: transport-error
  assert.deepEqual(b.errors.at(-1), ['WebSocket error: frame rejected'])

  // A child that exits ends its own connection and no other.
  childB.emit('exit', 3, null)
  // map: child-exit
  assert.deepEqual(disconnected, [['client-B', 'MCP server process exited']])
  handlers.onmessage(request, 'client-B')
  assert.deepEqual(childB.writes, [], 'nothing reaches an ended child')
  assert.deepEqual(b.info.at(-1), [
    'Dropped a message for ended client client-B',
  ])

  // A client that leaves stops its child; a second ending is a no-op.
  handlers.ondisconnection('client-A')
  handlers.ondisconnection('client-A')
  // map: client-disconnect
  assert.equal(childA.kills, 1)
  assert.deepEqual(disconnected.at(-1), ['client-A', 'Client disconnected'])
  assert.equal(disconnected.length, 2)
})
