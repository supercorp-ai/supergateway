import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

// Dependency failures may reject with any JavaScript value. Exercise the real
// bridge callback while replacing SDK/network boundaries, not bridge logic.
for (const protocol of ['sse', 'streamableHttp'] as const) {
  test(`${protocol} bridge normalizes dependency failures and preserves request identity`, async (t) => {
    const clients: any[] = []
    const connections: any[] = []
    const requests: any[] = []
    let stdio: any
    let rejection: unknown
    class Client {
      constructor(
        public info: unknown,
        public options: unknown,
      ) {
        clients.push(this)
      }
      async connect() {
        await this.request(initialize(0))
      }
      async request(message: any) {
        requests.push(structuredClone(message))
        if (message.method === 'initialize')
          return { protocolVersion: message.params.protocolVersion }
        if (message.method === 'tools/list') return { tools: [] }
        throw rejection
      }
    }
    class RemoteTransport {
      constructor(
        public url: URL,
        public options: unknown,
      ) {
        connections.push(this)
      }
    }
    class Server {
      transport: any
      async connect(transport: unknown) {
        this.transport = transport
        stdio = transport
      }
    }
    t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
      namedExports: { Client },
    })
    t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
      namedExports: { Server },
    })
    t.mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
      namedExports: { StdioServerTransport: class {} },
    })
    t.mock.module('@modelcontextprotocol/sdk/client/sse.js', {
      namedExports: { SSEClientTransport: RemoteTransport },
    })
    t.mock.module('@modelcontextprotocol/sdk/client/streamableHttp.js', {
      namedExports: { StreamableHTTPClientTransport: RemoteTransport },
    })
    t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
      namedExports: { onSignals() {} },
    })
    const module =
      protocol === 'sse'
        ? await import('../src/gateways/sseToStdio.js')
        : await import('../src/gateways/streamableHttpToStdio.js')
    const writes: string[] = []
    const output = t.mock.method(process.stdout, 'write', (chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const headers = { Authorization: 'Bearer boundary-token' }
    const url = `http://127.0.0.1:54321/${protocol === 'sse' ? 'sse' : 'mcp'}`
    const logger = { info() {}, error() {} }
    if ('sseToStdio' in module)
      await module.sseToStdio({ sseUrl: url, logger, headers })
    else
      await module.streamableHttpToStdio({
        streamableHttpUrl: url,
        logger,
        headers,
      })
    const init = {
      ...initialize(41),
      params: {
        protocolVersion: '2025-03-26',
        clientInfo: { name: 'boundary-client', version: '7.2.1' },
        capabilities: { roots: { listChanged: true } },
      },
    }
    await stdio.onmessage(init)
    assert.deepEqual(clients[0].info, init.params.clientInfo)
    assert.deepEqual(clients[0].options, {
      capabilities: init.params.capabilities,
    })
    assert.equal(requests[0].params.protocolVersion, '2025-03-26')
    assert.deepEqual(JSON.parse(writes.pop()!), {
      jsonrpc: '2.0',
      id: 41,
      result: { protocolVersion: '2025-03-26' },
    })
    assert.equal(connections[0].url.href, url)
    assert.deepEqual(connections[0].options.requestInit.headers, headers)

    const cases = [
      { rejected: null, code: -32000, message: 'Internal error' },
      { rejected: undefined, code: -32000, message: 'Internal error' },
      { rejected: 'socket lost', code: -32000, message: 'Internal error' },
      { rejected: {}, code: -32000, message: 'Internal error' },
      { rejected: { code: -32042 }, code: -32042, message: 'Internal error' },
      {
        rejected: { message: 'socket lost' },
        code: -32000,
        message: 'socket lost',
      },
      {
        rejected: { code: -32042, message: 'MCP error -32042:   bad query  ' },
        code: -32042,
        message: 'bad query',
      },
      {
        rejected: {
          code: -32042,
          message: 'MCP error -32099: keep this prefix',
        },
        code: -32042,
        message: 'MCP error -32099: keep this prefix',
      },
    ]
    for (const [index, item] of cases.entries()) {
      rejection = item.rejected
      const request = {
        jsonrpc: '2.0',
        id: `failure-${index}`,
        method: 'tools/call',
        params: { name: 'unavailable' },
      }
      const before = writes.length
      await stdio.onmessage(request)
      assert.equal(
        writes.length - before,
        1,
        'one response per rejected request',
      )
      assert.deepEqual(JSON.parse(writes.pop()!), {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: item.code, message: item.message },
      })
      assert.deepEqual(requests.at(-1), request)
    }
    await stdio.onmessage({ jsonrpc: '2.0', id: 99, method: 'tools/list' })
    assert.deepEqual(JSON.parse(writes.pop()!), {
      jsonrpc: '2.0',
      id: 99,
      result: { tools: [] },
    })
    const notification = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'ready' },
    }
    await stdio.onmessage(notification)
    assert.deepEqual(JSON.parse(writes.pop()!), notification)
    output.mock.restore()
  })
}
