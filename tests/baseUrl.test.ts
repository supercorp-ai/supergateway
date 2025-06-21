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
      'node tests/helpers/mock-mcp-server.js stdio',
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
    { stdio: 'ignore', shell: false },
  )
  gatewayProc.unref()
})

test.after(async () => {
  gatewayProc.kill('SIGINT')
  await new Promise((resolve) => gatewayProc.once('exit', resolve))
})

test('baseUrl should be passed correctly in endpoint event', async () => {
  const [{ Client }, { SSEClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ])

  const transport = new SSEClientTransport(new URL(SSE_PATH, BASE_URL))
  const client = new Client({ name: 'endpoint-tester', version: '1.0.0' })

  await new Promise((resolve) => setTimeout(resolve, 3000))

  await client.connect(transport)
  const endpoint = (transport as any)._endpoint as URL | undefined
  await client.close()
  transport.close()

  assert.ok(
    endpoint && endpoint.href.startsWith(`${BASE_URL}${MESSAGE_PATH}`),
    `endpoint should start with "${BASE_URL}${MESSAGE_PATH}", got: ${endpoint?.href}`,
  )
})
