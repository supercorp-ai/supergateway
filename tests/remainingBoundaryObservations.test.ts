import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'
import { getVersion } from '../src/lib/getVersion.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

for (const mode of ['sse', 'stateful', 'stateless', 'ws'] as const) {
  test(`${mode} gateway ignores empty frames and preserves boundary metadata`, async (t) => {
    const b = observeGateway(t)
    const args = {
      stdioCmd: 'peer --remaining',
      port: 8173,
      logger: b.logger,
      corsOrigin: false,
      healthEndpoints: ['/health'],
      headers: { 'X-Observed': 'present' },
      baseUrl: '',
      ssePath: '/events',
      messagePath: '/messages',
      streamableHttpPath: '/rpc',
      sessionTimeout: 25,
      protocolVersion: '2024-11-05',
    }
    enableFakeTimers(t)
    let wsHandlers: any
    const wsDisconnects: unknown[][] = []
    if (mode === 'sse') {
      const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
      await stdioToSse(args)
    } else if (mode === 'stateful') {
      const { stdioToStatefulStreamableHttp } = await import(
        '../src/gateways/stdioToStatefulStreamableHttp.js'
      )
      await stdioToStatefulStreamableHttp(args)
    } else if (mode === 'stateless') {
      const { stdioToStatelessStreamableHttp } = await import(
        '../src/gateways/stdioToStatelessStreamableHttp.js'
      )
      await stdioToStatelessStreamableHttp(args)
    } else {
      t.mock.module(
        new URL('../src/server/websocket.js', import.meta.url).href,
        {
          namedExports: {
            WebSocketServerTransport: class {
              constructor(_options: unknown, handlers: unknown) {
                wsHandlers = handlers
              }
              start() {}
              send() {}
              disconnect(...args: unknown[]) {
                wsDisconnects.push(args)
              }
            },
          },
        },
      )
      t.mock.module('http', {
        namedExports: {
          createServer: () => ({
            listen(_port: number, callback: () => void) {
              callback()
            },
          }),
        },
      })
      const { stdioToWs } = await import('../src/gateways/stdioToWs.js')
      await stdioToWs(args)
    }
    const initial =
      mode === 'stateful' || mode === 'stateless'
        ? await b.request('POST', '/rpc', { body: initialize(83) })
        : undefined
    // map: server-metadata
    //
    // The SSE gateway builds its `Server` per session rather than at startup —
    // a single shared one served one connection per process and crashed on the
    // second (#112, #138, #153) — so at this point it has none. WebSocket builds
    // none at all: it relays each connection to its own child. The two HTTP
    // modes still build theirs up front.
    assert.deepEqual(
      b.servers,
      mode === 'sse' || mode === 'ws'
        ? []
        : [
            [
              { name: 'supergateway', version: getVersion() },
              { capabilities: {} },
            ],
          ],
    )
    const connected =
      mode === 'sse' ? await b.request('GET', '/events') : undefined
    if (mode === 'ws') wsHandlers.onconnection('client-1')
    const before = b.info.length
    b.children[0].stdout.emit('data', Buffer.from('\n \r\n\t\n'))
    // map: empty-frames
    assert.deepEqual(
      {
        info: b.info.slice(before),
        errors: b.errors,
        sends: b.transports.flatMap((transport) => transport.sent),
      },
      { info: [], errors: [], sends: [] },
    )
    if (mode === 'sse') {
      const accepted = await b.request('POST', '/messages', {
        query: { sessionId: b.transports[0].sessionId },
        body: { jsonrpc: '2.0', id: 2, method: 'ping' },
      })
      const missing = await b.request('POST', '/messages')
      // map: sse-session-server
      assert.deepEqual(b.servers, [
        [{ name: 'supergateway', version: getVersion() }, { capabilities: {} }],
      ])
      // map: sse-response-headers
      assert.deepEqual(
        [connected!.res.headers, accepted.res.headers, missing.res.headers],
        [args.headers, args.headers, args.headers],
      )
    }
    if (mode === 'stateless') {
      const reply = { jsonrpc: '2.0', id: 83, result: {} }
      b.children[0].stdout.emit(
        'data',
        Buffer.from(JSON.stringify(reply) + '\n'),
      )
      b.children[0].stdout.emit(
        'data',
        Buffer.from(JSON.stringify(reply) + '\n'),
      )
      // map: explicit-initialize-reset
      assert.deepEqual(
        b.info.filter(
          ([message]) => message === 'Initialize response received',
        ),
        [['Initialize response received']],
      )
    }
    if (mode === 'stateful') {
      const session = b.transports[0].sessionId!
      initial!.res.emit('finish')
      initial!.res.emit('close')
      const get = await b.request('GET', '/rpc', {
        headers: { 'mcp-session-id': session },
      })
      get.res.emit('close')
      get.res.emit('finish')
      // map: response-diagnostics
      assert.deepEqual(
        b.info.filter(([message]) => message.startsWith('Response ')),
        [
          ['Response finished', session],
          ['Response closed', session],
        ],
      )
      t.mock.timers.tick(25)
      // map: idle-diagnostics
      assert.deepEqual(
        b.info.filter(
          ([message]) =>
            message === `Session ${session} timed out, cleaning up`,
        ),
        [
          [`Session ${session} timed out, cleaning up`],
          [`Session ${session} timed out, cleaning up`],
        ],
      )
    }
    if (mode === 'ws') {
      const codes: unknown[] = []
      t.mock.method(process, 'exit', (code): never => {
        codes.push(code)
        return undefined as never
      })
      // map: ws-child-exit — ends that connection, not the gateway
      b.children[0].emit('exit', 19, null)
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(codes, [])
      assert.deepEqual(wsDisconnects, [
        ['client-1', 'MCP server process exited'],
      ])
      // map: ws-child-diagnostic
      assert.deepEqual(b.info.at(-1), [
        'Child exited (client client-1): code=19, signal=null',
      ])
    }
  })
}
