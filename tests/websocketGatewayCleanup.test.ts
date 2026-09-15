import { observeChildSignals } from './helpers/child-signals.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// Observe calls at process and transport boundaries. Do not emit real signals
// or exit the test runner; the gateway's signal wiring and cleanup remain real.
test('WebSocket gateway cleans up before exit on shutdown, child failure and startup failure', async (t) => {
  t.mock.method(process.stdin, 'resume', () => process.stdin)
  const events: string[] = [],
    errors: string[] = []
  const handlers = new Map<string, () => void>()
  let child: Child
  let fail: 'spawn' | 'connect' | 'close' | undefined
  class Child extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = { write() {} }
    kill() {
      events.push('child.kill')
      return true
    }
  }
  class Transport {
    async close() {
      events.push('transport.close')
      if (fail === 'close') throw new Error('close failed')
    }
  }
  const originalOn = process.on
  t.mock.method(
    process,
    'on',
    function (
      this: typeof process,
      event: string,
      listener: (...args: any[]) => void,
    ) {
      if (['SIGINT', 'SIGTERM', 'SIGHUP'].includes(event)) {
        handlers.set(event, listener)
        return this
      }
      return originalOn.call(this, event, listener)
    },
  )
  const stdinOn: EventEmitter['on'] = process.stdin.on
  t.mock.method(
    process.stdin,
    'on',
    function (
      this: typeof process.stdin,
      event: string,
      listener: (...args: any[]) => void,
    ) {
      if (event === 'close') {
        handlers.set('stdin.close', listener)
        return this
      }
      stdinOn.call(this, event, listener)
      return this
    },
  )
  t.mock.method(process, 'exit', (code?: number | string | null): never => {
    events.push(`exit:${code}`)
    return undefined as never
  })
  const trackChild = observeChildSignals(t)
  t.mock.module('child_process', {
    namedExports: {
      spawn() {
        if (fail === 'spawn') throw new Error('spawn failed')
        child = new Child()
        return trackChild(child)
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
    namedExports: {
      Server: class {
        async connect() {
          if (fail === 'connect') throw new Error('connect failed')
        }
      },
    },
  })
  t.mock.module(new URL('../src/server/websocket.js', import.meta.url).href, {
    namedExports: { WebSocketServerTransport: Transport },
  })
  t.mock.module('http', {
    namedExports: { createServer: () => ({ listen() {} }) },
  })
  t.mock.module('express', { defaultExport: () => ({ use() {}, get() {} }) })
  const { stdioToWs } = await import('../src/gateways/stdioToWs.js')
  const args = {
    stdioCmd: 'controlled-peer',
    port: 0,
    messagePath: '/ws',
    logger: {
      info() {},
      error: (message: unknown) => errors.push(String(message)),
    },
    healthEndpoints: [],
    corsOrigin: false,
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'stdin.close']) {
    await stdioToWs(args)
    events.length = 0
    handlers.get(signal)!()
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(
      events,
      ['transport.close', 'child.kill', 'exit:0'],
      signal,
    )
  }
  await stdioToWs(args)
  events.length = 0
  child.emit('exit', 17, null)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['child.kill', 'transport.close', 'exit:17'])

  await stdioToWs(args)
  events.length = 0
  child.emit('exit', null, 'SIGKILL')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['child.kill', 'transport.close', 'exit:1'])

  for (const failure of ['connect', 'spawn'] as const) {
    fail = failure
    events.length = 0
    await stdioToWs(args)
    assert.deepEqual(
      events,
      failure === 'connect'
        ? ['transport.close', 'child.kill', 'exit:1']
        : ['exit:1'],
    )
    assert.equal(errors.at(-1), `Failed to start: ${failure} failed`)
  }
  fail = undefined
  await stdioToWs(args)
  fail = 'close'
  events.length = 0
  handlers.get('SIGTERM')!()
  await new Promise((resolve) => setImmediate(resolve))
  await Promise.resolve() // Drain the transport.close rejection handler.
  assert.deepEqual(events, ['transport.close', 'child.kill', 'exit:0'])
  assert.equal(errors.at(-1), 'Error stopping WebSocket server: close failed')
})
