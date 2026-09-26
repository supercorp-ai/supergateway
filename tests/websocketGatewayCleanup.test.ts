import { observeChildSignals } from './helpers/child-signals.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

// Observe calls at process and transport boundaries. Do not emit real signals
// or exit the test runner; the gateway's signal wiring and cleanup remain real.
test('WebSocket gateway stops every connection’s child on shutdown, and a failing child ends only its own connection', async (t) => {
  t.mock.method(process.stdin, 'resume', () => process.stdin)
  const events: string[] = [],
    errors: unknown[][] = []
  const signals = new Map<string, () => void>()
  let spawnFails = false
  class Child extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write() {} })
    constructor(readonly name: string) {
      super()
    }
    kill() {
      events.push(`kill:${this.name}`)
      return true
    }
  }
  let handlers: any
  class Transport {
    constructor(_options: unknown, h: unknown) {
      handlers = h
    }
    start() {}
    send() {}
    disconnect(clientId: string, reason: string) {
      events.push(`disconnect:${clientId}:${reason}`)
    }
    async close() {
      events.push('transport.close')
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
        signals.set(event, listener)
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
        signals.set('stdin.close', listener)
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
  const spawned: Child[] = []
  t.mock.module('child_process', {
    namedExports: {
      spawn() {
        if (spawnFails) throw new Error('spawn failed')
        const child = new Child(`c${spawned.length}`)
        spawned.push(child)
        return trackChild(child)
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
      error: (...message: unknown[]) => errors.push(message),
    },
    healthEndpoints: [],
    corsOrigin: false,
  }
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  // map: shutdown — every connection's child, then exit 0
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'stdin.close']) {
    await stdioToWs(args)
    handlers.onconnection('a')
    handlers.onconnection('b')
    const [a, b] = spawned.slice(-2)
    events.length = 0
    signals.get(signal)!()
    await settle()
    assert.deepEqual(
      events,
      ['transport.close', `kill:${a.name}`, `kill:${b.name}`, 'exit:0'],
      signal,
    )
  }

  // map: child failures end their own connection, and the gateway stays up
  await stdioToWs(args)
  handlers.onconnection('errors')
  handlers.onconnection('stdin')
  handlers.onconnection('healthy')
  const [failed, broken, healthy] = spawned.slice(-3)
  events.length = 0
  failed.emit('error', new Error('ENOENT'))
  broken.stdin.emit('error', new Error('EPIPE'))
  await settle()
  assert.deepEqual(events, [
    `kill:${failed.name}`,
    'disconnect:errors:MCP server process failed',
    `kill:${broken.name}`,
    'disconnect:stdin:MCP server process failed',
  ])
  assert.deepEqual(
    errors.slice(-2).map((entry) => entry[0]),
    ['Child failure (client errors):', 'Child stdin failure (client stdin):'],
  )
  assert.ok(!events.some((event) => event.startsWith('exit')))
  assert.ok(!events.includes(`kill:${healthy.name}`))

  // map: spawn failure — the connection is refused, the gateway stays up
  spawnFails = true
  events.length = 0
  handlers.onconnection('unlucky')
  assert.deepEqual(events, ['disconnect:unlucky:MCP server process failed'])
  assert.deepEqual(errors.at(-1), [
    'Failed to start the MCP server (client unlucky):',
    new Error('spawn failed'),
  ])
})
