import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

/**
 * The GW-016 normalisation, condition by condition.
 *
 * A transport failure carries a `code` that is not a JSON-RPC code — from SDK
 * 1.24 a failed POST throws `StreamableHTTPError` whose `code` is the HTTP
 * status — and forwarding it verbatim put `code: 503` on the wire, which no
 * client can interpret. The bridge now keeps the status in the message instead:
 *
 *   if (!isProtocolCode && typeof rawCode === 'number' &&
 *       !errorMsg.includes(`HTTP ${rawCode}`))
 *
 * Three conditions, and the existing suite only ever produced inputs where the
 * whole decision was false, so the assignment inside it had never run and no
 * condition had an independent witness. Each case below flips exactly one.
 *
 * All four run inside a single test per protocol on purpose: `t.mock.module` is
 * per test, but the module cache is not, so a second import of the same bridge
 * in one file hands back the instance already bound to the first test's mocks
 * and its handler never reaches the later closures.
 */
const cases = [
  {
    name: 'a transport status is moved into the message',
    rejection: Object.assign(Error('upstream temporarily unavailable'), {
      code: 503,
    }),
    // All three true: the branch runs.
    expect: (error: any) => {
      assert.equal(error.code, -32000, 'a status is not a JSON-RPC code')
      assert.match(
        error.message,
        /HTTP 503/,
        'the status is kept in the message',
      )
      assert.match(error.message, /upstream temporarily unavailable/)
    },
  },
  {
    name: 'a status already named in the message is not repeated',
    rejection: Object.assign(
      Error('HTTP 503: upstream temporarily unavailable'),
      {
        code: 503,
      },
    ),
    // Only `!errorMsg.includes(...)` is false.
    expect: (error: any) => {
      assert.equal(error.code, -32000)
      assert.equal(
        error.message.match(/HTTP 503/g)?.length,
        1,
        'the status appears once, not twice',
      )
    },
  },
  {
    name: 'a real JSON-RPC code is preserved',
    rejection: Object.assign(Error('MCP error -32001: request timed out'), {
      code: -32001,
    }),
    // Only `!isProtocolCode` is false.
    expect: (error: any) => {
      assert.equal(error.code, -32001, 'a protocol code passes through')
      assert.doesNotMatch(
        error.message,
        /HTTP/,
        'a protocol error is not described as an HTTP failure',
      )
    },
  },
  {
    name: 'a failure with no code at all is given the server-error code',
    rejection: Error('connection reset'),
    // Only `typeof rawCode === 'number'` is false.
    expect: (error: any) => {
      assert.equal(error.code, -32000)
      assert.doesNotMatch(error.message, /HTTP/)
      assert.match(error.message, /connection reset/)
    },
  },
] as const

for (const protocol of ['sse', 'streamableHttp'] as const) {
  test(`${protocol} bridge normalizes every error-code shape`, async (t) => {
    let stdio: any
    let rejection: unknown
    class Client {
      async connect() {
        await this.request(initialize(0))
      }
      async request(message: any) {
        if (message.method === 'initialize')
          return { protocolVersion: message.params.protocolVersion }
        throw rejection
      }
    }
    class RemoteTransport {
      constructor(
        public url: URL,
        public options: unknown,
      ) {}
    }
    class Server {
      transport: any
      async connect(transport: unknown) {
        // The bridge assigns its handler to `stdioServer.transport`, so the
        // mock has to expose it the way the real Server does.
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

    const writes: string[] = []
    t.mock.method(process.stdout, 'write', (chunk: unknown) => {
      writes.push(String(chunk))
      return true
    })
    const logger = { info() {}, error() {} }
    const url = `http://127.0.0.1:54321/${protocol === 'sse' ? 'sse' : 'mcp'}`
    if (protocol === 'sse') {
      const { sseToStdio } = await import('../src/gateways/sseToStdio.js')
      await sseToStdio({ sseUrl: url, logger, headers: {} } as never)
    } else {
      const { streamableHttpToStdio } = await import(
        '../src/gateways/streamableHttpToStdio.js'
      )
      await streamableHttpToStdio({
        streamableHttpUrl: url,
        logger,
        headers: {},
      } as never)
    }
    await stdio.onmessage(initialize(1))

    let id = 10
    for (const scenario of cases) {
      rejection = scenario.rejection
      const requestId = id++
      await stdio.onmessage({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/list',
      })
      const reply = writes
        .map((line) => JSON.parse(line))
        .find((message) => message.id === requestId)
      assert.ok(
        reply?.error,
        `${scenario.name}: expected an error reply, got ${JSON.stringify(reply)}`,
      )
      scenario.expect(reply.error)
    }
  })
}
