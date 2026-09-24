import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

// The other half of #27's deadline: once the handshake completes, the deadline
// has no power over the bridge. The mistake this pins is the obvious way to
// write a deadline — a timer that closes the transport, never cleared — which
// would end every healthy bridge thirty seconds after it started, worse than
// the hang it replaced. Merely leaving this implementation's timer armed is
// not that hazard: it rejects into a race the handshake has already won.
test(
  'a completed SSE handshake cannot be ended by its deadline',
  { timeout: 10000 },
  async (t) => {
    enableFakeTimers(t)
    let stdio: any
    let remote: any
    class Remote {
      onclose?: () => void
      onerror?: (error: Error) => void
      closes = 0
      constructor() {
        remote = this
      }
      async close() {
        this.closes++
        this.onclose?.()
      }
    }
    class Client {
      async connect() {}
      async request() {
        return { tools: [] }
      }
    }
    t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
      namedExports: { Client },
    })
    t.mock.module('@modelcontextprotocol/sdk/client/sse.js', {
      namedExports: { SSEClientTransport: Remote },
    })
    t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
      namedExports: {
        Server: class {
          transport: any
          async connect(transport: any) {
            stdio = this.transport = transport
          }
        },
      },
    })
    t.mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
      namedExports: { StdioServerTransport: class {} },
    })
    t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
      namedExports: { onSignals() {} },
    })
    const writes: string[] = []
    t.mock.method(process.stdout, 'write', (chunk: unknown) => {
      // The test runner reports on stdout too; keep only the bridge's replies.
      if (String(chunk).startsWith('{"jsonrpc"')) writes.push(String(chunk))
      return true
    })
    const exits: unknown[] = []
    t.mock.method(process, 'exit', (code: unknown) => {
      exits.push(code)
    })
    const { sseToStdio } = await import('../src/gateways/sseToStdio.js')
    await sseToStdio({
      sseUrl: 'http://127.0.0.1:19003/sse',
      logger: { info() {}, error() {} },
      headers: {},
    })

    await stdio.onmessage(initialize(1))
    t.mock.timers.tick(60_000)
    await new Promise((resolve) => setImmediate(resolve))
    await stdio.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' })

    assert.equal(
      remote.closes,
      0,
      'a completed handshake leaves the transport open',
    )
    assert.deepEqual(exits, [], 'and the bridge running')
    assert.deepEqual(
      writes.map((line) => JSON.parse(line).id),
      [1, 2],
      'both requests are answered',
    )
    assert.ok(writes.every((line) => !('error' in JSON.parse(line))))
  },
)
