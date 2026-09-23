import { test } from 'node:test'
import assert from 'node:assert/strict'
import { initialize } from './helpers/gateway-process.js'

test('a failed first connection and concurrent fallback initialization keep one upstream client', async (t) => {
  let stdio: any
  let attempts = 0
  let releaseConnect!: () => void
  const connectGate = new Promise<void>((resolve) => {
    releaseConnect = resolve
  })
  const writes: string[] = []
  class Client {
    async connect() {
      attempts++
      if (attempts === 1) throw new TypeError('fetch failed')
      await connectGate
      await this.request(initialize(0))
    }
    async request(message: any) {
      return {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
      }
    }
    async close() {}
  }
  class Remote {
    onclose?: () => void
    onerror?: (error: Error) => void
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
    streamableHttpUrl: 'http://127.0.0.1:19001/mcp',
    logger,
    headers: {},
  })

  const list = (id: number) => ({ jsonrpc: '2.0', id, method: 'tools/list' })
  await stdio.onmessage(list(1))
  assert.ok(JSON.parse(writes.at(-1)!).error)
  assert.equal(attempts, 1)

  const first = stdio.onmessage(list(2))
  const second = stdio.onmessage(initialize(3))
  releaseConnect()
  await Promise.all([first, second])
  assert.equal(
    attempts,
    2,
    'the pipelined initialize shares the fallback connect',
  )
  assert.deepEqual(
    writes
      .slice(-2)
      .map((line) => JSON.parse(line).id)
      .sort(),
    [2, 3],
  )
})
