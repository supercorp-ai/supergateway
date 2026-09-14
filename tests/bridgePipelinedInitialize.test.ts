import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

// While the SSE bridge is still connecting its upstream client, its temporary
// request wrapper is what serves any further stdin frame. The wrapper copies
// the caller's protocol version onto an outgoing initialize, and a pipelined
// initialize that carries no params at all must be forwarded as it is rather
// than faulting on the missing field.
test('SSE bridge forwards a pipelined initialize that omits params while connecting', async (t) => {
  const requests: any[] = [],
    writes: string[] = []
  let stdio: any, release: () => void
  const connected = new Promise<void>((resolve) => {
    release = resolve
  })
  t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
    namedExports: {
      Client: class {
        async connect() {
          await connected
          await this.request({
            ...initialize(0),
            params: { protocolVersion: '2024-11-05' },
          })
        }
        async request(message: any) {
          requests.push(structuredClone(message))
          return { served: message.method, forId: message.id ?? null }
        }
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/client/sse.js', {
    namedExports: { SSEClientTransport: class {} },
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
  const { sseToStdio } = await import('../src/gateways/sseToStdio.js')
  await sseToStdio({
    sseUrl: 'http://127.0.0.1:54321/events',
    logger: { info() {}, error() {} },
    headers: {},
  })
  // The handshake parks inside connect, leaving the wrapper installed.
  const handshake = stdio.onmessage(initialize(1))
  // A second initialize arrives before the upstream connection completes, and
  // this one carries no params for the wrapper to read a version from.
  const pipelined = stdio.onmessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
  })
  release!()
  await Promise.all([handshake, pipelined])
  output.mock.restore()
  // map: paramless-initialize-forwarded-unchanged
  assert.deepEqual(
    requests.find((message) => message.id === 2),
    { jsonrpc: '2.0', id: 2, method: 'initialize' },
    'the pipelined initialize reaches the upstream exactly as received, with no params invented for it',
  )
  // map: paramless-initialize-answered
  assert.deepEqual(
    writes.map((line) => JSON.parse(line)).find((message) => message.id === 2),
    { jsonrpc: '2.0', id: 2, result: { served: 'initialize', forId: 2 } },
    'the pipelined request is still answered under its own id',
  )
})
