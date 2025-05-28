import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { pathToFileURL } from 'node:url'

const PORT = 11000
const BASE_URL = `http://0.0.0.0:${PORT}`
const SSE_PATH = '/sse'
const MESSAGE_PATH = '/message'

let gatewayProc: ChildProcess // handle for teardown

/* ───────────────────────── bootstrap & teardown ───────────────────────── */

test.before(() => {
  /* 1️⃣  run your published CLI via npm so TS isn’t compiled twice */
  gatewayProc = spawn(
    'npm',
    [
      'run',
      'start',
      '--', // <-- everything after "--" is argv
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
      '--logLevel',
      'none',
    ],
    { stdio: 'inherit', shell: false }, // inherit logs; no extra shell layer
  )
})

test.after(() => {
  gatewayProc.kill('SIGINT') // clean shutdown (< 1 s)
})

/* ───────────────────────── actual assertion ───────────────────────────── */

test('baseUrl should be passed correctly in endpoint event', async (t) => {
  /* spy EventSource BEFORE SDK is imported ------------------------------ */
  const endpointSpy = t.mock.fn()
  const { EventSource } = await import('eventsource')
  class EventSourceSpy extends EventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url as any, init)
      this.addEventListener('endpoint', endpointSpy)
    }
    close() {
      super.close()
    } // expose socket close for GC
  }
  t.mock.module('eventsource', {
    defaultExport: EventSourceSpy,
    namedExports: { EventSource: EventSourceSpy },
  })

  /* SDK client ---------------------------------------------------------- */
  const [{ Client }, { SSEClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ])

  const transport = new SSEClientTransport(new URL(SSE_PATH, BASE_URL))
  const client = new Client({ name: 'endpoint-tester', version: '0.0.0' })

  await client.connect(transport)
  await client.close()
  console.log({
    client,
    transport,
  })
  // client.eventSource?.close(); // close the EventSource to release resources
  // transport.eventSource?.close();        // release socket immediately

  /* assertions ---------------------------------------------------------- */
  assert.strictEqual(endpointSpy.mock.callCount(), 1)

  const data: string = endpointSpy.mock.calls[0].arguments[0].data
  assert.ok(
    data.startsWith(MESSAGE_PATH) ||
      data.startsWith(`${BASE_URL}${MESSAGE_PATH}`),
    `endpoint data should start with "${MESSAGE_PATH}" or "${BASE_URL}${MESSAGE_PATH}", got: ${data}`,
  )
})
