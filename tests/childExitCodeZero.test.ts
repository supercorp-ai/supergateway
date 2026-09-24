import { observeChildSignals } from './helpers/child-signals.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { observeGateway } from './helpers/observed-gateway.js'

// SSE children are now scoped to sessions; their exit must not stop the gateway.
// WebSocket still has one process-wide child and passes through its exit code.

test('SSE gateway stays up when a session child exits 0', async (t) => {
  const b = observeGateway(t)
  const codes: unknown[] = []
  const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
  await stdioToSse({
    stdioCmd: 'peer --clean-exit',
    port: 8143,
    baseUrl: '',
    ssePath: '/events',
    messagePath: '/messages',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  })
  t.mock.method(process, 'exit', (code?: any): never => {
    codes.push(code)
    return undefined as never
  })
  const first = await b.request('GET', '/events')
  const firstId = b.transports[0].sessionId!
  b.children[0].emit('exit', 0, null)
  await new Promise((resolve) => setImmediate(resolve))
  // map: sse-clean-child-exit-code
  assert.deepEqual(
    codes,
    [],
    'the session child finishing must not terminate other gateway sessions',
  )
  assert.deepEqual(b.errors.at(-1), [
    `Child exited (session ${firstId}): code=0, signal=null`,
  ])
  assert.equal(b.serverCloses.length, 1)
  await b.request('GET', '/events')
  assert.equal(b.children.length, 2, 'a new session still starts')
  first.req.emit('close')
})

test('WebSocket gateway exits 0 when its child exits 0', async (t) => {
  t.mock.method(process.stdin, 'resume', () => process.stdin)
  const errors: string[] = [],
    codes: unknown[] = []
  let child: any
  class Child extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = { write: () => true }
    killed = false
    kill() {
      this.killed = true
      return true
    }
  }
  t.mock.method(process, 'exit', (code?: any): never => {
    codes.push(code)
    return undefined as never
  })
  const trackChild = observeChildSignals(t)
  t.mock.module('child_process', {
    namedExports: {
      spawn() {
        child = new Child()
        return trackChild(child)
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
    namedExports: {
      Server: class {
        async connect() {}
      },
    },
  })
  t.mock.module(new URL('../src/server/websocket.js', import.meta.url).href, {
    namedExports: {
      WebSocketServerTransport: class {
        async close() {}
      },
    },
  })
  t.mock.module('http', {
    namedExports: { createServer: () => ({ listen() {} }) },
  })
  t.mock.module('express', { defaultExport: () => ({ use() {}, get() {} }) })
  const { stdioToWs } = await import('../src/gateways/stdioToWs.js')
  await stdioToWs({
    stdioCmd: 'peer --clean-exit',
    port: 8144,
    messagePath: '/ws',
    logger: {
      info() {},
      error: (message: unknown) => errors.push(String(message)),
    },
    healthEndpoints: [],
    corsOrigin: false,
  })
  child.emit('exit', 0, null)
  await new Promise((resolve) => setImmediate(resolve))
  // map: ws-clean-child-exit-code
  assert.deepEqual(
    codes,
    [0],
    'the WebSocket gateway passes a child exit code of zero through as zero, not replaced by the failure default',
  )
  // map: ws-clean-child-exit-diagnostic
  assert.equal(errors.at(-1), 'Child exited: code=0, signal=null')
})
