import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
  const client = new Client({ name: 'stateful-test', version: '1.0.0' })
  await new Promise((r) => setTimeout(r, 2000))
  await client.connect(transport)

  assert.ok(transport.sessionId, 'sessionId should be set after connect')

  const { tools } = await client.listTools()
  assert.ok(tools.some((t) => t.name === 'add'))

  type Reply = { content: Array<{ text: string }> }
  const reply1 = (await client.callTool({
    name: 'add',
    arguments: { a: 1, b: 2 },
  })) as Reply

  assert.strictEqual(reply1.content[0].text, 'The sum of 1 and 2 is 3.')

  const reply2 = (await client.callTool({
    name: 'add',
    arguments: { a: 3, b: 4 },
  })) as Reply

  assert.strictEqual(reply2.content[0].text, 'The sum of 3 and 4 is 7.')

  await transport.terminateSession()
  assert.strictEqual(transport.sessionId, undefined)

  await client.close()
  transport.close()
})

test('stdioToStatefulStreamableHttp returns 404 for unknown session IDs', async () => {
  await new Promise((r) => setTimeout(r, 2000))

  const unknownSession = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': 'unknown-session-id',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    }),
  })

  assert.strictEqual(unknownSession.status, 404)
  assert.deepStrictEqual(await unknownSession.json(), {
    jsonrpc: '2.0',
    error: {
      code: -32001,
      message: 'Session not found',
    },
    id: null,
  })

  const missingSession = await fetch(MCP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    }),
  })

  assert.strictEqual(missingSession.status, 400)
})
