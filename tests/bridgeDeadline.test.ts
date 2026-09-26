// The bridges called `Client.request` without options, so the SDK's default
// deadline of 60 seconds applied: every tool call that took longer failed with
// "Request timed out" even when the stdio client was willing to wait. Measured
// before the fix: a 65-second tool, with the client's own timeout at 120s,
// failed after 60s through both bridges. The client owns the deadline; when it
// gives up it cancels, and the bridge relays that (bridgeCancellation.test.ts).
//
// Waiting out a real minute in the suite would cost a minute per bridge, so
// this checks the option the bridge passes instead.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

const DAY = 24 * 60 * 60 * 1000

for (const mode of ['sse', 'streamableHttp'] as const) {
  test(
    `${mode} bridge sets no deadline of its own on a client's request`,
    { timeout: 15000 },
    async (t) => {
      const seen: Array<{ method: string; options?: { timeout?: number } }> = []
      let stdio: any
      class Client {
        async connect() {
          await this.request({
            ...initialize(0),
            params: { protocolVersion: '2024-11-05' },
          })
        }
        async request(message: any, _schema?: unknown, options?: any) {
          seen.push({ method: message.method, options })
          return {}
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
      const output = t.mock.method(process.stdout, 'write', () => true)
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
      await stdio.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/call' })
      output.mock.restore()
      const call = seen.find((request) => request.method === 'tools/call')!
      assert.ok(
        (call.options?.timeout ?? 60_000) >= DAY,
        `the bridge's own deadline was ${call.options?.timeout ?? 'the SDK default of 60s'}`,
      )
    },
  )
}
