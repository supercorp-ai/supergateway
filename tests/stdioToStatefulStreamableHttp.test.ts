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

test('stdioToStatefulStreamableHttp session-id status codes', async () => {
  const JSON_HEADERS = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  }
  const toolsList = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  })
  const UNKNOWN_SESSION = '00000000-0000-4000-8000-000000000000'

  // A session id the gateway does not hold must be 404, not 400. Per the MCP
  // Streamable HTTP spec a client MUST re-initialize on 404, and that is the
  // only signal it gets; a 400 leaves it replaying a dead id forever.
  const postUnknown = await fetch(MCP_URL, {
    method: 'POST',
    headers: { ...JSON_HEADERS, 'mcp-session-id': UNKNOWN_SESSION },
    body: toolsList,
  })
  assert.strictEqual(postUnknown.status, 404, 'POST with unknown session id')

  const getUnknown = await fetch(MCP_URL, {
    method: 'GET',
    headers: { Accept: 'text/event-stream', 'mcp-session-id': UNKNOWN_SESSION },
  })
  assert.strictEqual(getUnknown.status, 404, 'GET with unknown session id')
  await getUnknown.body?.cancel()

  // The other direction: a genuinely absent header is still a 400. Without
  // this case the change above could be satisfied by returning 404 for
  // everything, which would be a different spec violation.
  const postMissing = await fetch(MCP_URL, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: toolsList,
  })
  assert.strictEqual(postMissing.status, 400, 'POST with no session id')

  const getMissing = await fetch(MCP_URL, {
    method: 'GET',
    headers: { Accept: 'text/event-stream' },
  })
  assert.strictEqual(getMissing.status, 400, 'GET with no session id')
  await getMissing.body?.cancel()
})
