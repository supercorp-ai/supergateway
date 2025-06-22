import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport as StreamableHttpClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = 11004
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
      '--stateful',
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

test('stdioToStatefulStreamableHttp listTools and callTool', async () => {
  const transport = new StreamableHttpClientTransport(new URL(MCP_URL))
  const client = new Client({ name: 'stateful-test', version: '1.0.0' })
  await new Promise((r) => setTimeout(r, 2000))
  await client.connect(transport)

  const { tools } = await client.listTools()
  assert.ok(tools.some((t) => t.name === 'add'))

  type Reply = { content: Array<{ text: string }> }
  const reply = (await client.callTool({
    name: 'add',
    arguments: { a: 1, b: 2 },
  })) as Reply

  assert.strictEqual(reply.content[0].text, 'The sum of 1 and 2 is 3.')
  await client.close()
  transport.close()
})
