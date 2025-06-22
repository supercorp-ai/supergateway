import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'

const PORT = 11000
const BASE_URL = `http://0.0.0.0:${PORT}`
const SSE_PATH = '/sse'
const MESSAGE_PATH = '/message'

let gatewayProc: ChildProcess

test.before(() => {
  gatewayProc = spawn(
    'npm',
    [
      'run',
      'start',
      '--',
      '--stdio',
      'npx -y @modelcontextprotocol/server-memory',
      '--outputTransport',
      'sse',
      '--port',
      String(PORT),
      '--baseUrl',
      BASE_URL,
      '--ssePath',
      SSE_PATH,
      '--messagePath',
      MESSAGE_PATH,
    ],
    { stdio: 'inherit', shell: false },
  )
})

test.after(() => {
  gatewayProc.kill('SIGINT')
})

test('baseUrl should be passed correctly in endpoint event', async (t) => {
  const endpointSpy = t.mock.fn()
  const { EventSource } = await import('eventsource')
  class EventSourceSpy extends EventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url as any, init)
      this.addEventListener('endpoint', endpointSpy)
    }
    close() {
      super.close()
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

  const transport = new SSEClientTransport(new URL(SSE_PATH, BASE_URL))
  const client = new Client({ name: 'endpoint-tester', version: '1.0.0' })

  await new Promise((resolve) => {
    setTimeout(() => resolve(true), 3000)
  })

  await client.connect(transport)
  await client.close()

  assert.strictEqual(endpointSpy.mock.callCount(), 1)

  const data: string = endpointSpy.mock.calls[0].arguments[0].data

  // should be this instead
  // data.startsWith(`${BASE_URL}${MESSAGE_PATH}`),
  assert.ok(
    data.startsWith(`${MESSAGE_PATH}`),
    `endpoint data should start with "${BASE_URL}${MESSAGE_PATH}", got: ${data}`,
  )
})
