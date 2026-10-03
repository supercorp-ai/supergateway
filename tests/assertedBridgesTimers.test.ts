import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

// The bridges' own timers must not keep the process they run in alive: the
// SSE bridge's handshake deadline once the handshake is done, and the
// Streamable HTTP bridge's background reconnect. The CLI always exits
// explicitly, so only a process that runs a bridge in-process (these tests)
// can see either one: left armed, the deadline held its test file open for
// thirty seconds after it passed.

// Timers that hold the event loop open. An unref'd timer is not counted.
const heldTimers = () =>
  process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length

// Everything the bridges use from the SDK, replaced: `Remote` is the upstream
// transport, `Client` the SDK client over it.
const mockSdk = (t: TestContext, Client: unknown, Remote: unknown) => {
  const stdio: { transport?: any } = {}
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
          stdio.transport = this.transport = transport
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
  const write = process.stdout.write.bind(process.stdout)
  t.mock.method(process.stdout, 'write', (chunk: any, ...rest: any[]) =>
    // The test runner reports on stdout too: only the bridge's replies are
    // dropped.
    String(chunk).startsWith('{"jsonrpc"') ? true : write(chunk, ...rest),
  )
  return stdio
}

const logger = { info() {}, error() {} }

test('a completed SSE handshake leaves no deadline holding the process', async (t) => {
  const stdio = mockSdk(
    t,
    class {
      async connect() {}
      async request() {
        return {}
      }
    },
    class {},
  )
  const { sseToStdio } = await import('../src/gateways/sseToStdio.js')
  await sseToStdio({
    sseUrl: 'http://127.0.0.1:19004/sse',
    logger,
    headers: {},
  })
  const before = heldTimers()
  await stdio.transport.onmessage(initialize(1))
  // map: the handshake's thirty-second deadline is cleared once it is met
  assert.equal(heldTimers(), before)
})

test('the Streamable HTTP bridge’s background reconnect does not hold the process', async (t) => {
  const remotes: { onclose?: () => void }[] = []
  let connects = 0
  const stdio = mockSdk(
    t,
    class {
      async connect() {
        connects++
      }
      async request() {
        return {}
      }
      async close() {}
    },
    class {
      constructor() {
        remotes.push(this)
      }
    },
  )
  const { streamableHttpToStdio } =
    await import('../src/gateways/streamableHttpToStdio.js')
  await streamableHttpToStdio({
    streamableHttpUrl: 'http://127.0.0.1:19004/mcp',
    logger,
    headers: {},
  })
  await stdio.transport.onmessage(initialize(1))
  const before = heldTimers()
  // The upstream closes: a reconnect is scheduled a second later.
  remotes[0].onclose!()
  // map: the scheduled reconnect is unref'd
  assert.equal(heldTimers(), before)
  // A request reconnects at once, and cancels the scheduled one.
  await stdio.transport.onmessage({ jsonrpc: '2.0', id: 2, method: 'ping' })
  assert.equal(connects, 2)
})
