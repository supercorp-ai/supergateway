import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as StreamableHttpClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = 11005
const MCP_URL = `http://localhost:${PORT}/mcp`

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
      'streamableHttp',
      '--port',
      String(PORT),
      '--streamableHttpPath',
      '/mcp',
    ],
    { stdio: 'ignore', shell: false },
  )
  gatewayProc.unref()
})

test.after(async () => {
  gatewayProc.kill('SIGINT')
  await new Promise((resolve) => gatewayProc.once('exit', resolve))
})

test('stdioToStatelessStreamableHttp listTools and callTool', async () => {
  const transport = new StreamableHttpClientTransport(new URL(MCP_URL))
  const client = new Client({ name: 'stateless-test', version: '1.0.0' })
  await new Promise((r) => setTimeout(r, 2000))
  await client.connect(transport)

  const { tools } = await client.listTools()
  assert.ok(tools.some((t) => t.name === 'add'))

  type Reply = { content: Array<{ text: string }> }
  const reply = (await client.callTool({
    name: 'add',
    arguments: { a: 4, b: 5 },
  })) as Reply

  assert.strictEqual(reply.content[0].text, 'The sum of 4 and 5 is 9.')
  await client.close()
  transport.close()
})

test('GET returns 405', async () => {
  const res = await fetch(MCP_URL)
  assert.strictEqual(res.status, 405)
})
