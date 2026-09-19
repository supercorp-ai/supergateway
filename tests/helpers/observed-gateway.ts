import { observeChildSignals } from './child-signals.js'
import { EventEmitter } from 'node:events'
import type { TestContext } from 'node:test'

// Controlled external boundaries shared by component tests. Gateway routing,
// parsing, callbacks, state and the session counter remain the real code.
export class Response extends EventEmitter {
  code = 200
  body: any
  headersSent = false
  destroyed = false
  destroy() {
    this.destroyed = true
    this.emit('close')
    return this
  }
  headers: Record<string, string> = {}
  setHeader(key: string, value: string) {
    this.headers[key] = value
  }
  status(code: number) {
    this.code = code
    return this
  }
  writeHead(code: number) {
    return this.status(code)
  }
  send(body: any) {
    this.body = body
    return this
  }
  json(body: any) {
    return this.send(body)
  }
  end(body: any) {
    return this.send(body)
  }
}

export function observeGateway(t: TestContext) {
  const info: any[][] = [],
    errors: any[][] = []
  const routes = new Map<string, (req: any, res: Response) => any>()
  const middleware: any[] = [],
    corsOptions: any[] = [],
    listens: number[] = []
  const spawns: any[][] = [],
    servers: any[][] = [],
    serverCloses: any[] = [],
    connections: any[] = []
  let serverCloseFailure: Error | null = null
  const children: Child[] = [],
    transports: Transport[] = []
  let parses = 0
  const parser = (_req: any, _res: any, next: () => void) => {
    parses++
    next()
  }
  const app = {
    use(fn: any) {
      middleware.push(fn)
    },
    get(path: string, handler: any) {
      routes.set(`GET ${path}`, handler)
    },
    post(path: string, handler: any) {
      routes.set(`POST ${path}`, handler)
    },
    delete(path: string, handler: any) {
      routes.set(`DELETE ${path}`, handler)
    },
    listen(port: number, callback: () => void) {
      listens.push(port)
      callback()
    },
  }
  class Child extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    writes: string[] = []
    stdin = Object.assign(new EventEmitter(), {
      write: (line: string) => {
        this.writes.push(line)
        return true
      },
    })
    kills = 0
    kill() {
      this.kills++
      return true
    }
  }
  class Transport {
    sessionId?: string
    onmessage?: (message: any) => void
    onclose?: () => void
    onerror?: (error: Error) => void
    sent: any[] = []
    handled: any[] = []
    closes = 0
    constructor(
      public options: any,
      public response?: Response,
    ) {
      if (typeof options === 'string')
        this.sessionId = `sse-${transports.length + 1}`
      transports.push(this)
    }
    async handleRequest(req: any, res: Response, body: any) {
      this.handled.push({ req, res, body })
      if (!this.sessionId && this.options.sessionIdGenerator) {
        this.sessionId = this.options.sessionIdGenerator()
        this.options.onsessioninitialized(this.sessionId)
      }
      if (body) this.onmessage?.(body)
    }
    async handlePostMessage(req: any, res: Response) {
      this.handled.push({ req, res })
      this.onmessage?.(req.body)
      res.status(202).send('Accepted')
    }
    async send(message: any, options?: any) {
      this.sent.push(structuredClone(message))
      // Routing is part of the message's fate, not decoration: a notification
      // sent without `relatedRequestId` goes to a stream that may not exist.
      this.sentOptions.push(options)
    }
    sentOptions: any[] = []
    async close() {
      this.closes++
      this.onclose?.()
    }
  }
  t.mock.module('express', {
    defaultExport: Object.assign(() => app, { json: () => parser }),
  })
  t.mock.module('body-parser', { defaultExport: { json: () => parser } })
  t.mock.module('cors', {
    defaultExport: (options: any) => {
      corsOptions.push(options)
      return 'cors-middleware'
    },
  })
  const trackChild = observeChildSignals(t)
  t.mock.module('child_process', {
    namedExports: {
      spawn(...args: any[]) {
        spawns.push(args)
        const child = new Child()
        children.push(child)
        return trackChild(child)
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
    namedExports: {
      Server: class {
        transport: any = null
        constructor(...args: any[]) {
          servers.push(args)
        }
        async connect(transport: any) {
          connections.push(transport)
          this.transport = transport
        }
        // Recorded, because a session's `Server` staying open is the same
        // defect one indirection along: the next `connect` on it throws.
        // `serverCloseFailure` lets a test make it reject, which is the only
        // way to reach the gateway's handler for a close that goes wrong.
        async close() {
          serverCloses.push(this)
          // Faithful to the SDK: `Protocol.close` closes its transport, and
          // `SSEServerTransport.close` fires `onclose`. That round trip is what
          // turns a naive teardown into unbounded recursion, so the mock has to
          // make it, or no test here could ever see it.
          this.transport?.onclose?.()
          if (serverCloseFailure) throw serverCloseFailure
        }
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/sse.js', {
    namedExports: { SSEServerTransport: Transport },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/streamableHttp.js', {
    namedExports: { StreamableHTTPServerTransport: Transport },
  })
  const signals: any[] = []
  t.mock.module(new URL('../../src/lib/onSignals.js', import.meta.url).href, {
    namedExports: {
      onSignals(options: any) {
        signals.push(options)
      },
    },
  })
  const request = async (method: string, path: string, options: any = {}) => {
    const req = Object.assign(new EventEmitter(), {
      method,
      path,
      headers: {},
      query: {},
      ip: '127.0.0.9',
      ...options,
    })
    const res = new Response()
    await routes.get(`${method} ${path}`)!(req, res)
    return { req, res }
  }
  return {
    info,
    errors,
    routes,
    middleware,
    corsOptions,
    listens,
    spawns,
    servers,
    serverCloses,
    failServerClose: (error: Error | null) => {
      serverCloseFailure = error
    },
    connections,
    children,
    transports,
    signals,
    request,
    parses: () => parses,
    logger: {
      info: (...args: any[]) => info.push(args),
      error: (...args: any[]) => errors.push(args),
    },
  }
}
