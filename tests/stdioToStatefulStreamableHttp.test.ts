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

// Regression test for https://github.com/supercorp-ai/supergateway/issues/126
// A duplicate GET /mcp for an already-active standalone SSE used to fire
// transport.onerror, which SIGTERMed the stdio child and destroyed the
// session. After the fix, the duplicate GET returns 409 and the child
// continues to serve the original session.
test('stdioToStatefulStreamableHttp survives duplicate SSE GET', async () => {
  // Use raw http.request so the long-lived first SSE response cannot interact
  // with undici's connection pool when subsequent requests run.
  const { request: nodeRequest } = await import('node:http')
  const url = new URL(MCP_URL)

  type RawResponse = {
    statusCode: number
    headers: Record<string, string | string[] | undefined>
    body: import('node:http').IncomingMessage
  }

  const send = (
    method: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<RawResponse> =>
    new Promise((resolve, reject) => {
      const req = nodeRequest(
        {
          method,
          host: url.hostname,
          port: url.port,
          path: url.pathname,
          headers,
        },
        (res) =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: res,
          }),
      )
      req.on('error', reject)
      if (body !== undefined) req.write(body)
      req.end()
    })

  // 1. Initialize a session.
  const init = await send(
    'POST',
    {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'conflict-test', version: '1.0.0' },
      },
    }),
  )
  const sessionId = init.headers['mcp-session-id'] as string | undefined
  assert.ok(sessionId, 'initialize must return mcp-session-id')
  init.body.resume()

  // 2. Open the standalone SSE stream and keep it open. This occupies the
  //    SDK's standaloneSseStreamId slot.
  const firstSse = await send('GET', {
    Accept: 'text/event-stream',
    'mcp-session-id': sessionId!,
    'mcp-protocol-version': '2025-06-18',
  })
  assert.strictEqual(firstSse.statusCode, 200, 'first GET should establish SSE')
  firstSse.body.resume()

  // 3. A duplicate GET for the same session — pre-fix this fired
  //    transport.onerror and SIGTERMed the stdio child.
  const secondSse = await send('GET', {
    Accept: 'text/event-stream',
    'mcp-session-id': sessionId!,
    'mcp-protocol-version': '2025-06-18',
  })
  assert.strictEqual(
    secondSse.statusCode,
    409,
    'duplicate GET should be rejected with 409',
  )
  secondSse.body.resume()

  // 4. Decisive check: the child is still alive and the session still routes.
  const tool = await send(
    'POST',
    {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sessionId!,
      'mcp-protocol-version': '2025-06-18',
    },
    JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 5, b: 7 } },
    }),
  )
  assert.strictEqual(
    tool.statusCode,
    200,
    'tools/call after duplicate-GET conflict must still succeed',
  )
  const toolText = await new Promise<string>((resolve, reject) => {
    let buffer = ''
    tool.body.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
    })
    tool.body.on('end', () => resolve(buffer))
    tool.body.on('error', reject)
  })
  assert.match(toolText, /The sum of 5 and 7 is 12\./)

  // 5. Cleanup the long-lived first SSE.
  firstSse.body.destroy()
})
