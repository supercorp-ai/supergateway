import { observeChildSignals } from './helpers/child-signals.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initialize } from './helpers/gateway-process.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

/**
 * The rejection handlers added for cluster A, exercised.
 *
 * Every one of them is a path that only runs when an async SDK call fails, and
 * supercov reported all four as `function not called` after the fix landed —
 * the defect was gone, the guard against it was unproven. That is the worst
 * shape for a fix whose whole claim is "this no longer kills the process":
 * nothing demonstrated the handler it now depends on.
 *
 * Real transports will not reject on demand, so these drive the gateways with a
 * transport whose `send`/`close` reject. That is not manufacturing an
 * impossible state — `SSEServerTransport.send` rejects with `Not connected`
 * whenever its response has gone, which is exactly the disconnect race the
 * cluster is about.
 */

class Child extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = Object.assign(new EventEmitter(), { write() {} })
  kill() {
    return true
  }
}

class Response extends EventEmitter {
  headersSent = false
  destroy() {}
  setHeader() {}
  status() {
    return this
  }
  send() {
    return this
  }
  json() {
    return this
  }
  write() {
    return true
  }
  end() {
    return this
  }
}

const expressMock = (routes: Map<string, (req: any, res: any) => unknown>) => ({
  use() {},
  get(path: string, handler: (req: any, res: any) => unknown) {
    routes.set(`GET ${path}`, handler)
  },
  post(path: string, handler: (req: any, res: any) => unknown) {
    routes.set(`POST ${path}`, handler)
  },
  delete(path: string, handler: (req: any, res: any) => unknown) {
    routes.set(`DELETE ${path}`, handler)
  },
  listen(_port: number, cb?: () => void) {
    cb?.()
  },
})

test('a failing SSE delivery is logged and drops only that session', async (t) => {
  const routes = new Map<string, (req: any, res: any) => unknown>()
  const children: Child[] = []
  const sent: unknown[] = []

  let sentinelId = 1
  class SseTransport {
    sessionId = `session-${sentinelId++}`
    onmessage?: (msg: unknown) => void
    onclose?: () => void
    onerror?: (err: Error) => void
    constructor(
      public endpoint: string,
      public res: Response,
    ) {}
    async start() {}
    async send(message: unknown) {
      sent.push(message)
      // What the real transport does once its response is gone.
      throw Error('Not connected')
    }
    async close() {}
  }

  t.mock.module('express', {
    defaultExport: Object.assign(() => expressMock(routes), {
      json: () => () => {},
    }),
  })
  t.mock.module('body-parser', {
    defaultExport: { json: () => () => {} },
    namedExports: { json: () => () => {} },
  })
  t.mock.module('cors', { defaultExport: () => () => {} })
  const trackChild = observeChildSignals(t)
  t.mock.module('child_process', {
    namedExports: {
      spawn() {
        const child = new Child()
        children.push(child)
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
  t.mock.module('@modelcontextprotocol/sdk/server/sse.js', {
    namedExports: { SSEServerTransport: SseTransport },
  })
  t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
    namedExports: { onSignals() {} },
  })

  const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
  const errors: string[] = []
  await stdioToSse({
    stdioCmd: 'controlled-peer',
    port: 0,
    baseUrl: '',
    ssePath: '/sse',
    messagePath: '/message',
    logger: { info() {}, error: (message) => errors.push(String(message)) },
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  } as never)

  // Two subscribers, so a failure for one must not be mistaken for a shutdown.
  const open = routes.get('GET /sse')!
  const request = () => Object.assign(new EventEmitter(), { ip: '::1' })
  await open(request(), new Response())
  await open(request(), new Response())

  const child = children[0]
  child.stdout.emit(
    'data',
    Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n'),
  )
  // The rejection is delivered on a later microtask than the synchronous
  // fan-out loop, so let it settle before asserting.
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(sent.length, 2, 'the message is offered to both subscribers')
  assert.ok(
    errors.some((message) => message.includes('Failed to send to session')),
    `the failure is reported, got: ${JSON.stringify(errors)}`,
  )
})

for (const [label, moduleId, gatewayName, args] of [
  [
    'stateful',
    '../src/gateways/stdioToStatefulStreamableHttp.js',
    'stdioToStatefulStreamableHttp',
    { sessionTimeout: null },
  ],
  [
    'stateless',
    '../src/gateways/stdioToStatelessStreamableHttp.js',
    'stdioToStatelessStreamableHttp',
    { protocolVersion: '2024-11-05' },
  ],
] as const) {
  test(`${label} HTTP survives a failing transport close when its child exits`, async (t) => {
    const routes = new Map<string, (req: any, res: any) => unknown>()
    const children: Child[] = []

    class Transport {
      sessionId?: string
      onclose?: () => void
      constructor(public options: any) {}
      async handleRequest() {
        if (!this.sessionId && this.options?.sessionIdGenerator) {
          this.sessionId = this.options.sessionIdGenerator()
          this.options.onsessioninitialized?.(this.sessionId)
        }
      }
      async send() {}
      async close() {
        throw Error('close failed')
      }
    }

    t.mock.module('express', {
      defaultExport: Object.assign(() => expressMock(routes), {
        json: () => () => {},
      }),
    })
    t.mock.module('cors', { defaultExport: () => () => {} })
    const trackChild = observeChildSignals(t)
    t.mock.module('child_process', {
      namedExports: {
        spawn() {
          const child = new Child()
          children.push(child)
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
    t.mock.module('@modelcontextprotocol/sdk/server/streamableHttp.js', {
      namedExports: { StreamableHTTPServerTransport: Transport },
    })
    t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
      namedExports: { onSignals() {} },
    })

    const module = await import(moduleId)
    const gateway = (module as Record<string, any>)[gatewayName]
    const errors: string[] = []
    enableFakeTimers(t)
    await gateway({
      stdioCmd: 'controlled-peer',
      port: 0,
      streamableHttpPath: '/mcp',
      logger: { info() {}, error: (message) => errors.push(String(message)) },
      corsOrigin: false,
      healthEndpoints: [],
      headers: {},
      ...args,
    })

    await routes.get('POST /mcp')!(
      { method: 'POST', headers: {}, body: initialize() },
      new Response(),
    )
    assert.ok(children.length > 0, 'the gateway spawned a child to close over')

    // The child dying is what triggers the close, and the close now rejects.
    children[0].emit('exit', 1, null)
    await new Promise((resolve) => setImmediate(resolve))

    assert.ok(
      errors.some((message) => message.includes('Failed to close transport')),
      `the failed close is reported rather than thrown, got: ${JSON.stringify(errors)}`,
    )
  })
}
