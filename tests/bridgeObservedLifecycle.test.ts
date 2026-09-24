import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'
import { getVersion } from '../src/lib/getVersion.js'

for (const mode of ['sse', 'streamableHttp'] as const) {
  test(`${mode} bridge restores the SDK request method and reports transport events`, async (t) => {
    const clients: Client[] = [],
      remotes: any[] = [],
      servers: any[][] = [],
      requests: any[] = [],
      signals: any[] = []
    const info: any[][] = [],
      errors: any[][] = [],
      writes: string[] = []
    let stdio: any
    let nextRequestFailure: unknown
    let probeDuringConnect = false
    let nextCloseFailure: Error | undefined
    class Client {
      constructor(
        public info: any,
        public options: any,
      ) {
        clients.push(this)
      }
      async connect() {
        if (probeDuringConnect)
          await this.request({ jsonrpc: '2.0', id: 0, method: 'ping' })
        await this.request({
          ...initialize(0),
          params: {
            protocolVersion: '2025-03-26',
            clientInfo: { name: 'sdk', version: '1' },
            capabilities: {},
          },
        })
      }
      async request(message: any) {
        requests.push(structuredClone(message))
        if (nextRequestFailure !== undefined) {
          const failure = nextRequestFailure
          nextRequestFailure = undefined
          throw failure
        }
        return {
          protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        }
      }
      async close() {
        if (nextCloseFailure) {
          const failure = nextCloseFailure
          nextCloseFailure = undefined
          throw failure
        }
      }
    }
    class Remote {
      onerror?: (error: Error) => void
      onclose?: () => void
      constructor(
        public url: URL,
        public options: any,
      ) {
        remotes.push(this)
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
          constructor(...args: any[]) {
            servers.push(args)
          }
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
      namedExports: {
        onSignals(options: any) {
          signals.push(options)
        },
      },
    })
    const output = t.mock.method(process.stdout, 'write', (chunk: any) => {
      writes.push(String(chunk))
      return true
    })
    const logger = {
      info: (...args: any[]) => info.push(args),
      error: (...args: any[]) => errors.push(args),
    }
    const url = 'http://127.0.0.1:54321/upstream'
    const headers = { 'X-Trace': 'bridge-lifecycle' }
    if (mode === 'sse') {
      const { sseToStdio } = await import('../src/gateways/sseToStdio.js')
      await sseToStdio({ sseUrl: url, logger, headers })
    } else {
      const { streamableHttpToStdio } = await import(
        '../src/gateways/streamableHttpToStdio.js'
      )
      await streamableHttpToStdio({ streamableHttpUrl: url, logger, headers })
    }
    const label = mode === 'sse' ? 'SSE' : 'Streamable HTTP'
    // map: startup
    assert.deepEqual(info, [
      [`  - ${mode}: ${url}`],
      [`  - Headers: ${JSON.stringify(headers)}`],
      [`Connecting to ${label}...`],
      ['Stdio server listening'],
    ])
    // map: setup
    assert.deepEqual(
      {
        servers,
        signals,
      },
      {
        servers: [
          [
            { name: 'supergateway', version: getVersion() },
            { capabilities: {} },
          ],
        ],
        signals: [{ logger }],
      },
    )
    const original = Client.prototype.request
    const input = initialize(41)
    await stdio.onmessage(input)
    assert.deepEqual(
      {
        url: remotes[0].url.href,
        headers: remotes[0].options.requestInit.headers,
      },
      { url, headers },
    )
    // map: restore-request
    assert.equal(clients[0].request, original)
    // map: initialize-forward
    assert.equal(
      requests[0].params.protocolVersion,
      input.params.protocolVersion,
    )
    // map: initialized-response
    assert.deepEqual(JSON.parse(writes.at(-1)!), {
      jsonrpc: '2.0',
      id: 41,
      result: { protocolVersion: input.params.protocolVersion },
    })
    // map: connected-diagnostics
    assert.deepEqual(info.slice(-3), [
      [`Stdio → ${label}:`, input],
      [`${label} connected`],
      ['Response:', JSON.parse(writes.at(-1)!)],
    ])
    const later = {
      ...initialize(42),
      params: { ...input.params, protocolVersion: '2025-03-26' },
    }
    await stdio.onmessage(later)
    // map: subsequent-version
    assert.deepEqual(
      { request: requests.at(-1), reply: JSON.parse(writes.at(-1)!) },
      {
        request: later,
        reply: {
          jsonrpc: '2.0',
          id: 42,
          result: { protocolVersion: '2025-03-26' },
        },
      },
    )
    const notification = { jsonrpc: '2.0', method: 'notifications/initialized' }
    const before = writes.length
    await stdio.onmessage(notification)
    // map: notification-diagnostic
    // `connect` already sent the server its own `notifications/initialized`, so
    // the client's copy is absorbed rather than relayed — and it must not be
    // written back down stdout, which returned the client its own message.
    assert.deepEqual(info.at(-1), [
      `Client initialized; ${label} handshake already sent one`,
    ])
    assert.equal(writes.length, before)
    const fault = new Error('upstream disconnected')
    remotes[0].onerror(fault)
    // map: transport-error
    assert.deepEqual(errors.at(-1), [`${label} error:`, fault])
    const exited = new Error('exit observed'),
      codes: unknown[] = []
    t.mock.method(process, 'exit', (code?: any): never => {
      codes.push(code)
      throw exited
    })
    if (mode === 'sse') {
      assert.throws(
        () => remotes[0].onclose(),
        (error) => error === exited,
      )
      assert.deepEqual(
        { codes, error: errors.at(-1) },
        { codes: [1], error: [`${label} connection closed`] },
      )
    } else {
      const closeFailure = Error('stale client close failed')
      nextCloseFailure = closeFailure
      remotes[0].onclose()
      assert.deepEqual(codes, [], 'the stdio bridge survives upstream closure')
      assert.deepEqual(errors.at(-1), [`${label} connection closed`])
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(errors.at(-1), [
        'Failed to close stale Streamable HTTP client:',
        closeFailure,
      ])
      const beforeReconnect = requests.length
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 43,
        method: 'tools/list',
      })
      assert.equal(clients.length, 2, 'recovery uses a fresh MCP client')
      assert.deepEqual(
        {
          url: remotes[1].url.href,
          headers: remotes[1].options.requestInit.headers,
          version: requests[beforeReconnect].params.protocolVersion,
        },
        { url, headers, version: input.params.protocolVersion },
        'recovery preserves the original URL, headers and protocol version',
      )
      assert.deepEqual(codes, [])
      remotes[1].onerror(
        new Error('Maximum reconnection attempts (2) exceeded.'),
      )
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 44,
        method: 'tools/list',
      })
      assert.equal(
        clients.length,
        3,
        'SDK retry exhaustion also rebuilds the client',
      )
      assert.deepEqual(codes, [])
      remotes[1].onerror(
        new Error('Maximum reconnection attempts (2) exceeded.'),
      )
      assert.equal(
        clients.length,
        3,
        'a stale transport cannot evict its successor',
      )
      for (const [status, prefix] of [
        ['404', ''],
        ['503', 'MCP error -32000: '],
      ]) {
        nextRequestFailure = new Error(
          `${prefix}Error POSTing to endpoint (HTTP ${status}): unavailable`,
        )
        const clientCount = clients.length
        await stdio.onmessage({
          jsonrpc: '2.0',
          id: 50 + clientCount,
          method: 'tools/list',
        })
        assert.ok(JSON.parse(writes.at(-1)!).error)
        await stdio.onmessage({
          jsonrpc: '2.0',
          id: 60 + clientCount,
          method: 'tools/list',
        })
        assert.equal(clients.length, clientCount + 1)
      }
      const beforeToolError = clients.length
      for (const code of [404, 503]) {
        nextRequestFailure = Object.assign(new Error('tool item absent'), {
          code,
        })
        await stdio.onmessage({
          jsonrpc: '2.0',
          id: 68,
          method: 'tools/list',
        })
        assert.ok(JSON.parse(writes.at(-1)!).error)
        assert.equal(clients.length, beforeToolError)
      }

      nextRequestFailure = Object.assign(
        new Error('Streamable HTTP error: Error POSTing to endpoint: denied'),
        { code: 400 },
      )
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 69,
        method: 'tools/list',
      })
      assert.equal(clients.length, beforeToolError)
      nextRequestFailure = new Error(
        'Streamable HTTP error: Error POSTing to endpoint: unknown status',
      )
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 76,
        method: 'tools/list',
      })
      assert.equal(clients.length, beforeToolError)

      nextRequestFailure = Object.assign(
        new Error('Streamable HTTP error: Error POSTing to endpoint: down'),
        { code: 503 },
      )
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 70,
        method: 'tools/list',
      })
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 75,
        method: 'tools/list',
      })
      assert.equal(clients.length, beforeToolError + 1)

      nextRequestFailure = 'ordinary upstream error'
      const clientCount = clients.length
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 74,
        method: 'tools/list',
      })
      assert.ok(JSON.parse(writes.at(-1)!).error)
      assert.equal(clients.length, clientCount)
      nextRequestFailure = new TypeError('ordinary upstream type error')
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 71,
        method: 'tools/list',
      })
      assert.ok(JSON.parse(writes.at(-1)!).error)
      assert.equal(clients.length, clientCount)

      probeDuringConnect = true
      remotes.at(-1).onclose()
      const beforeProbe = requests.length
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: 72,
        method: 'tools/list',
      })
      assert.deepEqual(requests[beforeProbe], {
        jsonrpc: '2.0',
        id: 0,
        method: 'ping',
      })
      remotes.at(-1).onclose()
      const beforeRepeatInitialize = clients.length
      await stdio.onmessage(initialize(73))
      assert.equal(clients.length, beforeRepeatInitialize + 1)
      assert.equal(JSON.parse(writes.at(-1)!).id, 73)
    }
    output.mock.restore()
  })
}
