import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'

test('WebSocket gateway reports connections, peer traffic and asynchronous send failure', async (t) => {
  const b = observeGateway(t)
  let transport: Transport
  const sent: any[][] = []
  let failure: Error | undefined
  class Transport {
    onmessage?: (message: any) => void
    onconnection?: (id: string) => void
    ondisconnection?: (id: string) => void
    onerror?: (error: Error) => void
    constructor() {
      transport = this
    }
    async send(...args: any[]) {
      sent.push(args)
      if (failure) throw failure
    }
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
  // map: setup
  assert.deepEqual(
    {
      spawns: b.spawns,
      listens: b.listens,
      cors: b.corsOptions,
      routes: [...b.routes.keys()],
      connected: b.connections[0] === transport!,
    },
    {
      spawns: [
        [
          'peer --ws-test',
          { shell: true, detached: process.platform !== 'win32' },
        ],
      ],
      listens: [8141],
      cors: [{ origin: '*' }],
      routes: ['GET /health'],
      connected: true,
    },
  )
  const health = await b.request('GET', '/health')
  // map: health
  assert.deepEqual(
    { code: health.res.code, body: health.res.body },
    { code: 200, body: 'ok' },
  )
  transport!.onconnection!('client-17')
  transport!.ondisconnection!('client-17')
  // map: connection-events
  assert.deepEqual(b.info.slice(-2), [
    ['New WebSocket connection: client-17'],
    ['WebSocket connection closed: client-17'],
  ])
  transport!.onerror!(new Error('frame rejected'))
  // map: transport-error
  assert.deepEqual(b.errors.at(-1), ['WebSocket error: frame rejected'])
  const message = { jsonrpc: '2.0', id: 'client-17:9', method: 'ping' }
  transport!.onmessage!(message)
  // map: request
  assert.deepEqual(
    { line: b.children[0].writes.at(-1), log: b.info.at(-1) },
    {
      line: JSON.stringify(message) + '\n',
      log: [`WebSocket → Child: ${JSON.stringify(message)}`],
    },
  )
  const reply = { jsonrpc: '2.0', id: message.id, result: {} }
  b.children[0].stdout.emit(
    'data',
    Buffer.from('\n \n' + JSON.stringify(reply) + '\n'),
  )
  // map: reply
  assert.deepEqual(
    { sent, log: b.info.at(-1) },
    {
      sent: [[reply, message.id]],
      log: [`Child → WebSocket: ${JSON.stringify(reply)}`],
    },
  )
  failure = new Error('socket write failed')
  b.children[0].stdout.emit('data', Buffer.from(JSON.stringify(reply) + '\n'))
  await Promise.resolve() // Wait for the asynchronous send rejection handler.
  // map: send-failure
  assert.deepEqual(b.errors.at(-1), ['Failed to broadcast message:', failure])
  b.children[0].stdout.emit('data', Buffer.from('bad-json\n'))
  b.children[0].stderr.emit('data', Buffer.from('socket warning\n'))
  // map: peer-diagnostics
  assert.deepEqual(
    { error: b.errors.at(-1), info: b.info.at(-1) },
    {
      error: ['Child non-JSON: bad-json'],
      info: ['Child stderr: socket warning\n'],
    },
  )
})
