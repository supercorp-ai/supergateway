import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { knownBugTest } from './helpers/known-bug.js'

/**
 * The WebSocket gateway's health endpoint reports two unhealthy states — the
 * child has been killed, and the server has not finished starting. Neither had
 * ever been observed: both windows close before a normal test can reach them,
 * so coverage showed the two 500 responses as never executed.
 *
 * `isReady` is set only after `await server.connect(...)`, so a connect that
 * never settles holds the gateway in its starting state for as long as the test
 * needs. That is the real window rather than a manufactured one — it is what a
 * slow upstream looks like.
 */
class Child extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  stdin = { write() {} }
  killed = false
  kill() {
    this.killed = true
    return true
  }
}

class Recorder {
  calls: Array<{ status?: number; body?: unknown }> = []
  private pending?: number
  status(code: number) {
    this.pending = code
    return this
  }
  send(body: unknown) {
    this.calls.push(
      this.pending === undefined ? { body } : { status: this.pending, body },
    )
    this.pending = undefined
    return this
  }
}

async function startHalfwayUp(t: {
  mock: { module: (id: string, impl: unknown) => unknown }
}) {
  const routes = new Map<string, (req: unknown, res: Recorder) => unknown>()
  const children: Child[] = []

  t.mock.module('express', {
    defaultExport: Object.assign(
      () => ({
        use() {},
        get(path: string, handler: (req: unknown, res: Recorder) => unknown) {
          routes.set(path, handler)
        },
        listen() {},
      }),
      { json: () => () => {} },
    ),
  })
  t.mock.module('cors', { defaultExport: () => () => {} })
  t.mock.module('http', {
    namedExports: { createServer: () => ({ listen() {}, on() {} }) },
  })
  t.mock.module('child_process', {
    namedExports: {
      spawn() {
        const child = new Child()
        children.push(child)
        return child
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
    namedExports: {
      Server: class {
        // Never settles, so `isReady` stays false.
        connect() {
          return new Promise(() => {})
        }
      },
    },
  })
  t.mock.module(new URL('../src/server/websocket.js', import.meta.url).href, {
    namedExports: {
      WebSocketServerTransport: class {
        async send() {}
        async close() {}
      },
    },
  })
  t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
    namedExports: { onSignals() {} },
  })

  const { stdioToWs } = await import('../src/gateways/stdioToWs.js')
  // Deliberately not awaited: it cannot resolve while connect is pending.
  void stdioToWs({
    stdioCmd: 'controlled-peer',
    port: 0,
    messagePath: '/message',
    logger: { info() {}, error() {} },
    corsOrigin: false,
    healthEndpoints: ['/health'],
  } as never)
  await new Promise((resolve) => setImmediate(resolve))

  const health = routes.get('/health')
  assert.ok(health, 'the health endpoint is registered before startup finishes')
  return { health, children }
}

test('the health endpoint reports an unready server and a dead child', async (t) => {
  const { health, children } = await startHalfwayUp(t)

  const unready = new Recorder()
  health(null, unready)
  assert.ok(
    unready.calls.some(
      (call) => call.status === 500 && call.body === 'Server is not ready',
    ),
    `a server still starting answers 500: ${JSON.stringify(unready.calls)}`,
  )

  children[0].kill()
  const dead = new Recorder()
  health(null, dead)
  assert.ok(
    dead.calls.some(
      (call) =>
        call.status === 500 && call.body === 'Child process has been killed',
    ),
    `a killed child answers 500: ${JSON.stringify(dead.calls)}`,
  )
})

/**
 * GW-019: neither unhealthy branch returns, so both fall through. Measured:
 *
 *   unready    500 'Server is not ready'                    then 'ok'
 *   dead child 500 'Child process has been killed'
 *              then 500 'Server is not ready'               then 'ok'
 *
 * Against real Express the later sends raise ERR_HTTP_HEADERS_SENT, so a
 * monitor receives the first status with an error logged behind it. The
 * endpoint is one `return` away from answering `ok` for a gateway whose child is
 * dead, which is the precise failure a health check exists to prevent — a load
 * balancer reading it keeps routing traffic to a broken gateway.
 *
 * Held rather than fixed: a behaviour change to a user-visible endpoint belongs
 * with cluster F, not in a coverage pass.
 */
knownBugTest(
  'GW-019',
  'the health endpoint sends exactly one response',
  { timeout: 15000 },
  async (t) => {
    const { health, children } = await startHalfwayUp(
      t as unknown as Parameters<typeof startHalfwayUp>[0],
    )

    const unready = new Recorder()
    health(null, unready)
    assert.deepEqual(
      unready.calls,
      [{ status: 500, body: 'Server is not ready' }],
      'an unready server answers once, and does not then claim to be ok',
    )

    children[0].kill()
    const dead = new Recorder()
    health(null, dead)
    assert.deepEqual(
      dead.calls,
      [{ status: 500, body: 'Child process has been killed' }],
      'a dead child answers once, and does not then claim to be ok',
    )
  },
)
