// GW-013: both upstream-to-stdio bridges build their reply envelope with
// `req.jsonrpc || '2.0'`, so a request carrying a non-2.0 version is answered
// with that same version. JSON-RPC 2.0 requires every response to carry "2.0".
// Recorded as a specification, not enabled: asserting the current reply would
// bless a non-conformant envelope.
//
// Found by mutation audit rather than by coverage: replacing the expression
// with the constant '2.0' passes the entire suite, because every other test
// sends a conformant request and cannot tell the two apart.
import { knownBugTest } from './helpers/known-bug.js'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

for (const mode of ['sse', 'streamableHttp'] as const) {
  knownBugTest(
    'GW-013',
    `${mode} bridge answers a non-2.0 request with a conformant 2.0 envelope`,
    { timeout: 15000 },
    async (t) => {
      const writes: string[] = []
      let stdio: any
      class Client {
        async connect() {
          await this.request({
            ...initialize(0),
            params: { protocolVersion: '2024-11-05' },
          })
        }
        async request(message: any) {
          return { served: message.method }
        }
      }
      t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
        namedExports: { Client },
      })
      t.mock.module('@modelcontextprotocol/sdk/client/sse.js', {
        namedExports: { SSEClientTransport: class {} },
      })
      t.mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', {
        namedExports: { StreamableHTTPClientTransport: class {} },
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
      await stdio.onmessage(initialize(1))
      await stdio.onmessage({ jsonrpc: '1.0', id: 2, method: 'tools/list' })
      output.mock.restore()
      const reply = writes
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 2)
      assert.equal(
        reply.jsonrpc,
        '2.0',
        'a response must declare JSON-RPC 2.0 regardless of what the request declared',
      )
    },
  )
}
