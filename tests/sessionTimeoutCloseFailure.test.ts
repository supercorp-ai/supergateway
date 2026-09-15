import { observeChildSignals } from './helpers/child-signals.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initialize } from './helpers/gateway-process.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

/**
 * Its own file on purpose. `t.mock.module` is per test, but the module cache is
 * not: a second import of the same gateway in one file returns the instance
 * already bound to the first test's mocks, so its routes register into a map
 * this test never sees. The repo's other mocked-gateway tests are one per file
 * for the same reason.
 *
 * Covers the session-timeout close handler, which supercov reported as
 * `function not called` after cluster A landed.
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

test('a failing transport close on session timeout is logged, not thrown', async (t) => {
  const routes = new Map<string, (req: any, res: any) => unknown>()
  const children: Child[] = []

  class Transport {
    sessionId?: string
    onclose?: () => void
    constructor(public options: any) {}
    async handleRequest() {
      if (!this.sessionId) {
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

  const { stdioToStatefulStreamableHttp } = await import(
    '../src/gateways/stdioToStatefulStreamableHttp.js'
  )
  const errors: string[] = []
  enableFakeTimers(t)
  await stdioToStatefulStreamableHttp({
    stdioCmd: 'controlled-peer',
    port: 0,
    streamableHttpPath: '/mcp',
    logger: { info() {}, error: (message) => errors.push(String(message)) },
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
    sessionTimeout: 50,
  } as never)

  const response = new Response()
  await routes.get('POST /mcp')!(
    { method: 'POST', headers: {}, body: initialize() },
    response,
  )
  // Releasing the request drops the session to idle and arms the deadline.
  response.emit('finish')
  response.emit('close')
  t.mock.timers.tick(200)
  await new Promise((resolve) => setImmediate(resolve))

  assert.ok(
    errors.some((message) => message.includes('Failed to close timed-out')),
    `the timed-out close reports its failure, got: ${JSON.stringify(errors)}`,
  )
})
