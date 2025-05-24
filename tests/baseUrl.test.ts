import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stdioToSse } from '../src/gateways/stdioToSse.js'
import { getLogger } from '../src/lib/getLogger.js'

// 0.0.0.0 is just simplest to test on all machines
// also tested with ngrok just to make sure
const baseUrl = 'http://0.0.0.0:11000'
const ssePath = '/sse'
const messagePath = '/message'

test.before(async () => {
  await stdioToSse({
    stdioCmd: 'npx -y @modelcontextprotocol/server-memory',
    port: 11000,
    baseUrl,
    ssePath,
    messagePath,
    logger: getLogger({ logLevel: 'none', outputTransport: 'stdio' }),
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  })
})

test.after(async () => {
  await new Promise<void>((res) => setTimeout(res, 5000))
  process.kill(process.pid, 'SIGINT')
})

test('baseUrl should be passed correctly in endpoint event', async (t) => {
  const endpointSpy = t.mock.fn()

  const { EventSource } = await import('eventsource')

  class EventSourceSpy extends EventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url as any, init)
      this.addEventListener('endpoint', endpointSpy)
    }
  }

  t.mock.module('eventsource', {
    defaultExport: EventSourceSpy,
    namedExports: { EventSource: EventSourceSpy },
  })

  const [{ Client }, { SSEClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ])

  const transport = new SSEClientTransport(new URL(ssePath, baseUrl))
  const client = new Client({ name: 'endpoint-tester', version: '0.0.0' })

  await client.connect(transport)
  await client.close()

  assert.strictEqual(
    endpointSpy.mock.callCount(),
    1,
    'endpoint event should fire exactly once',
  )

  const data = endpointSpy.mock.calls[0].arguments[0].data

  assert.ok(
    data.startsWith(`${baseUrl}${messagePath}`),
    `expected endpoint URL to start with ${baseUrl}${messagePath}, got ${data}`,
  )
})
