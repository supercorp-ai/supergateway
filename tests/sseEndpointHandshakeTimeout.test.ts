import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

// #27: an SSE server that opens a stream and never sends `event: endpoint`.
// The SDK's handshake waits for that event with no deadline of its own, so the
// bridge bounds the wait, tells the client which half of the handshake is
// missing, and stops — the SDK's transport cannot be started a second time.
//
// Two gateways share one module instance on purpose. The fallback case runs
// first because a fallback handshake that fails never assigns the module's
// shared client, which leaves the initialize path free for the second gateway.
test(
  'an SSE upstream that never completes its handshake is reported to the client, then the bridge stops',
  { timeout: 10000 },
  async (t) => {
    enableFakeTimers(t)
    let stdio: any
    const remotes: Remote[] = []
    class Remote {
      onclose?: () => void
      onerror?: (error: Error) => void
      closes = 0
      constructor(
        public url: URL,
        public options: any,
      ) {
        remotes.push(this)
      }
      async close() {
        this.closes++
        this.onclose?.()
      }
    }
    class Client {
      // The endpoint event never arrives, so the handshake never settles.
      connect() {
        return new Promise(() => {})
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
    t.mock.method(
      process.stdout,
      'write',
      (chunk: unknown, done?: () => void) => {
        // The test runner reports on stdout too; keep only the bridge's replies.
        if (String(chunk).startsWith('{"jsonrpc"')) writes.push(String(chunk))
        done?.()
        return true
      },
    )
    const exits: unknown[] = []
    t.mock.method(process, 'exit', (code: unknown) => {
      exits.push(code)
    })
    const logger = { info() {}, error() {} }
    const replies = () => writes.map((line) => JSON.parse(line))
    const { sseToStdio } = await import('../src/gateways/sseToStdio.js')

    // Gateway 1: the stream is refused, and the first request is not initialize,
    // so the handshake runs through the fallback client.
    await sseToStdio({
      sseUrl: 'http://127.0.0.1:19001/sse',
      logger,
      headers: {},
    })
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('', { status: 404 }),
    )
    await remotes[0].options.eventSourceInit.fetch('http://127.0.0.1:19001/sse')
    const listed = stdio.onmessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/list',
    })
    t.mock.timers.tick(29_999)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(writes, [], 'the deadline is thirty seconds, not less')
    t.mock.timers.tick(1)
    await listed
    assert.deepEqual(replies(), [
      {
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32000,
          message:
            'SSE server at http://127.0.0.1:19001/sse did not open an event stream within 30s.',
        },
      },
    ])
    assert.equal(remotes[0].closes, 1, 'the unusable transport is closed')
    assert.deepEqual(exits, [1], 'and closing it stops the bridge')

    // Gateway 2: the stream opens, the client sends initialize, and the endpoint
    // event never follows — the report in #27.
    writes.length = 0
    exits.length = 0
    await sseToStdio({
      sseUrl: 'http://127.0.0.1:19002/sse',
      logger,
      headers: {},
    })
    t.mock.method(
      globalThis,
      'fetch',
      async () =>
        new Response('', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    )
    await remotes[1].options.eventSourceInit.fetch('http://127.0.0.1:19002/sse')
    const initialized = stdio.onmessage(initialize(8))
    t.mock.timers.tick(30_000)
    await initialized
    assert.deepEqual(replies(), [
      {
        jsonrpc: '2.0',
        id: 8,
        error: {
          code: -32000,
          message:
            'SSE server at http://127.0.0.1:19002/sse opened an event stream but sent no `endpoint` event within 30s. An MCP SSE server must first send `event: endpoint` with the URL to POST messages to. If this server uses Streamable HTTP, connect with --streamableHttp instead.',
        },
      },
    ])
    assert.equal(remotes[1].closes, 1)
    assert.deepEqual(exits, [1])
  },
)
