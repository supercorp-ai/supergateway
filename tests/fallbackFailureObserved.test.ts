import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getVersion } from '../src/lib/getVersion.js'

for (const mode of ['sse', 'streamableHttp'] as const) {
  test(`${mode} bridge reports fallback connection failure with the original request identity`, async (t) => {
    const constructors: any[][] = [],
      connections: any[] = [],
      info: any[][] = [],
      errors: any[][] = [],
      writes: string[] = []
    const failure = new Error('upstream connection refused')
    let stdio: any, remote: any
    let closes = 0
    t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
      namedExports: {
        Client: class {
          constructor(...args: any[]) {
            constructors.push(args)
          }
          async connect(transport: any) {
            connections.push(transport)
            throw failure
          }
          // A client that could not connect is closed, and a close that
          // fails as well does not replace what the client is told.
          async close() {
            closes++
            throw new Error('close failed too')
          }
        },
      },
    })
    class Remote {
      constructor() {
        remote = this
      }
    }
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
    const logger = {
      info: (...args: any[]) => info.push(args),
      error: (...args: any[]) => errors.push(args),
    }
    if (mode === 'sse') {
      const { sseToStdio } = await import('../src/gateways/sseToStdio.js')
      await sseToStdio({
        sseUrl: 'http://127.0.0.1:54321/events',
        logger,
        headers: {},
      })
    } else {
      const { streamableHttpToStdio } =
        await import('../src/gateways/streamableHttpToStdio.js')
      await streamableHttpToStdio({
        streamableHttpUrl: 'http://127.0.0.1:54321/rpc',
        logger,
        headers: {},
      })
    }
    await stdio.onmessage({
      jsonrpc: '2.0',
      id: 'request-92',
      method: 'tools/list',
    })
    // map: fallback-client
    assert.deepEqual(constructors, [
      [{ name: 'supergateway', version: getVersion() }, { capabilities: {} }],
    ])
    // map: fallback-connect
    assert.deepEqual(connections, [remote])
    // map: fallback-diagnostic
    assert.deepEqual(info.at(-1), [
      `${mode === 'sse' ? 'SSE' : 'Streamable HTTP'} client not initialized, creating fallback client`,
    ])
    // map: failure-diagnostic
    assert.deepEqual(errors, [['Request error:', failure]])
    // The Streamable HTTP bridge reconnects with a new client each time, so
    // the one that failed is closed. The SSE bridge has one client for life.
    assert.equal(closes, mode === 'sse' ? 0 : 1)
    // map: failure-envelope
    assert.deepEqual(
      writes.map((line) => JSON.parse(line)),
      [
        {
          jsonrpc: '2.0',
          id: 'request-92',
          error: { code: -32000, message: 'upstream connection refused' },
        },
      ],
    )
    output.mock.restore()
  })
}
