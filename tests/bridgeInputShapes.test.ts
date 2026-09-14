import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

// Both upstream-to-stdio bridges classify every stdin frame before forwarding
// it, and stamp a protocol version onto the reply they build. Neither decision
// had been observed with a frame that omits the field it reads.
for (const mode of ['sse', 'streamableHttp'] as const) {
  test(`${mode} bridge defaults a missing jsonrpc version and passes non-request frames straight through`, async (t) => {
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
    class Remote {
      constructor(
        public url: URL,
        public options: any,
      ) {}
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
    // Establish the upstream client first; the fallback path a non-initialize
    // first frame would take is GW-001 and is covered as a TODO elsewhere.
    await stdio.onmessage(initialize(1))
    // A request is identified by method and id, so a frame that omits jsonrpc
    // is still forwarded, and the reply supplies the version the client left out.
    await stdio.onmessage({ id: 2, method: 'tools/list' })
    // A frame with no method is not a request at all: the left side of the
    // classification short-circuits and the frame is relayed untouched.
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
      framed[2],
      relayed,
      'a frame carrying no method is relayed verbatim rather than treated as a request',
    )
  })
}
