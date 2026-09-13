import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { observeGateway } from './helpers/observed-gateway.js'

// A child that finishes its work and exits 0 must leave the gateway exiting 0
// too, so a supervisor, container runtime or CI step sees success. Both
// gateways spell this `process.exit(code ?? 1)`, and zero is the one value that
// separates it from `code || 1`: every other observed exit code is truthy and
// both forms agree there. Existing child-exit tests use 17, 19, 23 and a null
// code for the signal case, so the successful exit was never observed.

test('SSE gateway exits 0 when its child exits 0', async (t) => {
  const b = observeGateway(t)
  const exited = new Error('exit observed')
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
    throw exited
  })
  assert.throws(
    () => b.children[0].emit('exit', 0, null),
    (error) => error === exited,
  )
  // map: sse-clean-child-exit-code
  assert.deepEqual(
    codes,
    [0],
    'a child exit code of zero is passed through as zero, not replaced by the failure default',
  )
  // map: sse-clean-child-exit-diagnostic
  assert.deepEqual(b.errors.at(-1), ['Child exited: code=0, signal=null'])
})

test('WebSocket gateway exits 0 when its child exits 0', async (t) => {
  const errors: string[] = [],
    codes: unknown[] = []
  const exited = new Error('exit observed')
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
    throw exited
  })
  t.mock.module('child_process', {
    namedExports: {
      spawn() {
        child = new Child()
        return child
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
  assert.throws(
    () => child.emit('exit', 0, null),
    (error) => error === exited,
  )
  // map: ws-clean-child-exit-code
  assert.deepEqual(
    codes,
    [0],
    'a child exit code of zero is passed through as zero, not replaced by the failure default',
  )
  // map: ws-clean-child-exit-diagnostic
  assert.equal(errors.at(-1), 'Child exited: code=0, signal=null')
})
