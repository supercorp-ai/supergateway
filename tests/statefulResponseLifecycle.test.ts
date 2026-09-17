import { observeChildSignals } from './helpers/child-signals.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { initialize } from './helpers/gateway-process.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

// Keep the real gateway and session counter. Control only HTTP/SDK/process
// boundaries so both response events and the idle deadline are deterministic.
test('stateful response completion releases once and cleanup cancels session timers', async (t) => {
  type Handler = (req: any, res: Response) => Promise<void>
  const routes = new Map<string, Handler>()
  const app = {
    use() {},
    post(path: string, handler: Handler) {
      routes.set(`POST ${path}`, handler)
    },
    get(path: string, handler: Handler) {
      routes.set(`GET ${path}`, handler)
    },
    delete(path: string, handler: Handler) {
      routes.set(`DELETE ${path}`, handler)
    },
    listen() {},
  }
  class Response extends EventEmitter {
    code = 200
    destroyed = false
    destroy() {
      this.destroyed = true
      this.emit('close')
    }
    body: unknown
    status(code: number) {
      this.code = code
      return this
    }
    send(body: unknown) {
      this.body = body
      return this
    }
    json(body: unknown) {
      this.body = body
      return this
    }
  }
  class Child extends EventEmitter {
    stdout = new EventEmitter()
    stderr = new EventEmitter()
    stdin = Object.assign(new EventEmitter(), { write() {} })
    kills = 0
    kill() {
      this.kills++
      return true
    }
  }
  let beforeSession = false
  const children: Child[] = [],
    transports: Transport[] = []
  class Transport {
    sessionId?: string
    onclose?: () => void
    onerror?: (error: Error) => void
    closes = 0
    constructor(
      public options: {
        sessionIdGenerator: () => string
        onsessioninitialized: (id: string) => void
      },
    ) {
      transports.push(this)
    }
    async handleRequest(_req: unknown, res: Response) {
      if (beforeSession) {
        res.emit('finish')
        return
      }
      if (!this.sessionId) {
        this.sessionId = this.options.sessionIdGenerator()
        this.options.onsessioninitialized(this.sessionId)
      }
    }
    async close() {
      this.closes++
      this.onclose?.()
    }
  }
  t.mock.module('express', {
    defaultExport: Object.assign(() => app, { json: () => () => {} }),
  })
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
  const { SessionAccessCounter } = await import(
    '../src/lib/sessionAccessCounter.js'
  )
  const { stdioToStatefulStreamableHttp } = await import(
    '../src/gateways/stdioToStatefulStreamableHttp.js'
  )
  // Spies preserve the real methods, including their state transitions.
  const decrement = t.mock.method(SessionAccessCounter.prototype, 'dec')
  const clear = t.mock.method(SessionAccessCounter.prototype, 'clear')
  const logs: string[] = []
  enableFakeTimers(t)
  await stdioToStatefulStreamableHttp({
    stdioCmd: 'controlled-peer',
    port: 0,
    streamableHttpPath: '/mcp',
    logger: { info: (message) => logs.push(String(message)), error() {} },
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
    sessionTimeout: 50,
  })
  const request = async (method: string, session?: string) => {
    const response = new Response()
    await routes.get(`${method} /mcp`)!(
      {
        method,
        headers: session ? { 'mcp-session-id': session } : {},
        body: initialize(),
      },
      response,
    )
    return response
  }

  const initial = await request('POST')
  const session = transports[0].sessionId!
  initial.emit('finish')
  initial.emit('close')
  assert.deepEqual(
    decrement.mock.calls.map((c) => c.arguments),
    [[session, 'POST response finished']],
  )
  t.mock.timers.tick(49)
  const activeGet = await request('GET', session)
  const concurrentPost = await request('POST', session)
  concurrentPost.emit('finish')
  concurrentPost.emit('close')
  assert.equal(
    decrement.mock.callCount(),
    2,
    'POST finish and close release one active request',
  )
  t.mock.timers.tick(500)
  assert.equal(
    transports[0].closes,
    0,
    'the outstanding GET keeps the session active',
  )
  assert.equal(children[0].kills, 0, 'active work keeps its child alive')
  activeGet.emit('close')
  activeGet.emit('finish')
  assert.deepEqual(
    decrement.mock.calls.map((c) => c.arguments),
    [
      [session, 'POST response finished'],
      [session, 'POST response finished'],
      [session, 'GET response closed'],
    ],
  )
  t.mock.timers.tick(49)
  assert.equal(
    transports[0].closes,
    0,
    'idle expiration waits for the whole deadline',
  )
  t.mock.timers.tick(1)
  assert.equal(
    transports[0].closes,
    1,
    'idle expiration closes the registered transport',
  )
  assert.equal(children[0].kills, 1, 'transport closure terminates its child')
  const expiredGet = await request('GET', session)
  assert.equal(expiredGet.code, 400)
  assert.equal(expiredGet.body, 'Invalid or missing session ID')
  const expiredPost = await request('POST', session)
  assert.deepEqual(
    { code: expiredPost.code, body: expiredPost.body },
    {
      code: 400,
      body: {
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      },
    },
  )

  // Closing removes a session; a reported request error preserves its lifetime.
  // A bounded fake-clock advance makes the absence check deterministic.
  const closing = await request('POST')
  const closeSession = transports[1].sessionId!
  closing.emit('finish')
  closing.emit('close')
  await transports[1].close()
  assert.deepEqual(clear.mock.calls.at(-1)!.arguments, [
    closeSession,
    false,
    'transport being closed',
  ])
  assert.equal(children[1].kills, 1)
  t.mock.timers.tick(100)
  assert.equal(
    logs.some((line) => line.includes(`Session ${closeSession} timed out`)),
    false,
  )
  assert.equal((await request('GET', closeSession)).code, 400)

  const failing = await request('POST')
  const errorSession = transports[2].sessionId!
  failing.emit('finish')
  failing.emit('close')
  const clearsBeforeError = clear.mock.callCount()
  transports[2].onerror!(new Error('unsupported request version'))
  assert.equal(clear.mock.callCount(), clearsBeforeError)
  assert.equal(children[2].kills, 0, 'a rejected request preserves its child')
  const recovered = await request('GET', errorSession)
  assert.equal(recovered.code, 200)
  recovered.emit('close')
  t.mock.timers.tick(100)
  assert.equal(
    children[2].kills,
    1,
    'the recovered session still expires when idle',
  )
  assert.equal(
    logs.some((line) => line.includes(`Session ${errorSession} timed out`)),
    true,
  )
  assert.equal((await request('GET', errorSession)).code, 400)
  assert.equal(
    children.length,
    3,
    'expired IDs never spawn a replacement child',
  )

  // Spawn/pipe failures can happen before the SDK assigns an initialization ID.
  // No counter belongs to this failed exchange; closing it must not affect a
  // different session or schedule an idle timer for an undefined ID.
  beforeSession = true
  const clears = clear.mock.callCount(),
    decrements = decrement.mock.callCount()
  const incomplete = await request('POST')
  assert.equal(transports[3].sessionId, undefined)
  assert.equal(decrement.mock.callCount(), decrements)
  children[3].stdin.emit(
    'error',
    new Error('spawn failed before initialization'),
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(incomplete.destroyed, true)
  assert.equal(children[3].kills, 1)
  assert.equal(transports[3].closes, 1)
  assert.equal(clear.mock.callCount(), clears)
  assert.equal(decrement.mock.callCount(), decrements)
})
