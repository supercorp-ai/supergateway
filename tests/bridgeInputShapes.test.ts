import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

// Both upstream-to-stdio bridges classify every stdin frame before forwarding
// it, and stamp a protocol version onto the reply they build. Neither decision
// had been observed with a frame that omits the field it reads.
for (const mode of ['sse', 'streamableHttp'] as const) {
  test(`${mode} bridge defaults a missing jsonrpc version and forwards non-request frames to the server`, async (t) => {
    const writes: string[] = []
    let stdio: any
    class Client {
      constructor(
        public info: any,
        public options: any,
      ) {}
      async connect() {
        await this.request(initialize(0))
      }
      async request(message: any) {
        return { echoed: message.method }
      }
    }
    const upstream: unknown[] = []
    class Remote {
      constructor(
        public url: URL,
        public options: any,
      ) {}
      async send(message: unknown) {
        upstream.push(message)
      }
    }
    t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
      namedExports: { Client },
    })
    t.mock.module('@modelcontextprotocol/sdk/client/sse.js', {
      namedExports: { SSEClientTransport: Remote },
    })
    t.mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', {
      namedExports: { StreamableHTTPClientTransport: Remote },
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
    const output = t.mock.method(process.stdout, 'write', (chunk: any) => {
      writes.push(String(chunk))
      return true
    })
    const logger = { info() {}, error() {} }
    if (mode === 'sse') {
      const { sseToStdio } = await import('../src/gateways/sseToStdio.js')
      await sseToStdio({
        sseUrl: 'http://127.0.0.1:54321/events',
        logger,
        headers: {},
      })
    } else {
      const { streamableHttpToStdio } = await import(
        '../src/gateways/streamableHttpToStdio.js'
      )
      await streamableHttpToStdio({
        streamableHttpUrl: 'http://127.0.0.1:54321/rpc',
        logger,
        headers: {},
      })
    }
    // A non-request frame that arrives before the upstream client exists has
    // nowhere to go. It must be reported rather than thrown, and above all must
    // not be written back down stdout to the client that just sent it.
    await stdio.onmessage({
      jsonrpc: '2.0' as const,
      method: 'notifications/cancelled',
    })
    // map: pre-connect-frame
    assert.deepEqual(upstream, [], 'nothing is sent before the client connects')
    assert.equal(writes.length, 0, 'and nothing is echoed back')
    // Establish the upstream client first; the fallback path a non-initialize
    // first frame would take is GW-001 and is covered as a TODO elsewhere.
    await stdio.onmessage(initialize(1))
    // A request is identified by method and id, so a frame that omits jsonrpc
    // is still forwarded, and the reply supplies the version the client left out.
    await stdio.onmessage({ id: 2, method: 'tools/list' })
    // A frame with no method is not a request at all — it is this client
    // answering something the server asked of it, so it belongs upstream.
    // Writing it to stdout, which is what the classification used to do,
    // returned the client its own message and left the server waiting.
    const relayed = { jsonrpc: '2.0' as const, id: 3, result: { ok: true } }
    await stdio.onmessage(relayed)
    output.mock.restore()
    const framed = writes.map((line) => JSON.parse(line))
    // map: versionless-request-answered
    assert.deepEqual(
      framed[1],
      { jsonrpc: '2.0', id: 2, result: { echoed: 'tools/list' } },
      'a request without jsonrpc is answered with the default protocol version and its own id',
    )
    // map: non-request-relayed
    assert.deepEqual(
      upstream,
      [relayed],
      'a frame carrying no method is forwarded to the server rather than treated as a request',
    )
    assert.equal(
      framed.length,
      2,
      'the client is not sent its own frame back down stdout',
    )
  })
}
