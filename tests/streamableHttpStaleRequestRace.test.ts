import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

test('a late failure from an old request cannot close the reconnected upstream', async (t) => {
  let stdio: any
  let rejectPending!: (error: Error) => void
  const clients: Client[] = []
  const remotes: Remote[] = []
  const writes: string[] = []
  const lostSession = () =>
    Object.assign(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: Session not found',
      ),
      { code: 404 },
    )
  class Client {
    constructor() {
      clients.push(this)
    }
    async connect() {
      await this.request(initialize(0))
    }
    async request(message: any): Promise<any> {
      if (message.method === 'initialize')
        return { serverInfo: { name: 'peer' } }
      if (message.id === 2)
        return new Promise((_, reject) => {
          rejectPending = reject
        })
      if (message.id === 3) throw lostSession()
      return { tools: [{ name: 'list' }] }
    }
    async close() {}
  }
  class Remote {
    onclose?: () => void
    onerror?: (error: Error) => void
    constructor() {
      remotes.push(this)
    }
  }
  t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
    namedExports: { Client },
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
  t.mock.method(process.stdout, 'write', (chunk: any) => {
    writes.push(String(chunk))
    return true
  })
  const logger = { info() {}, error() {} }
  const { streamableHttpToStdio } = await import(
    '../src/gateways/streamableHttpToStdio.js'
  )
  await streamableHttpToStdio({
    streamableHttpUrl: 'http://127.0.0.1:19002/mcp',
    logger,
    headers: {},
  })
  const list = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' })
  await stdio.onmessage(initialize(1))

  const oldRequest = stdio.onmessage(list(2))
  assert.equal(typeof rejectPending, 'function')
  await stdio.onmessage(list(3))
  assert.ok(JSON.parse(writes.at(-1)!).error)
  await stdio.onmessage(list(4))
  assert.equal(clients.length, 2)

  rejectPending(lostSession())
  await oldRequest
  assert.ok(writes.some((line) => JSON.parse(line).id === 2))
  await stdio.onmessage(list(5))
  assert.deepEqual(JSON.parse(writes.at(-1)!).result.tools, [{ name: 'list' }])
  assert.equal(
    clients.length,
    2,
    'the late failure did not evict the successor',
  )
  assert.equal(remotes.length, 2)
})
