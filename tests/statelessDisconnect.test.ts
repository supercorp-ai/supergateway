import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Regression test for #143: a client that disconnects before the child's response
// is forwarded must NOT crash the gateway process (un-awaited transport.send()
// rejection -> unhandled rejection -> process exit). After firing several aborted
// requests the gateway must still serve a normal request.

const PORT = 11072
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
  await new Promise((r) => gatewayProc.once('exit', r))
})

const init = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'x', version: '0' },
  },
})

test('#143 gateway survives client disconnect mid-response', async () => {
  await new Promise((r) => setTimeout(r, 2000))
  for (let i = 0; i < 8; i++) {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 20 + i * 15)
    try {
      await fetch(MCP_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: init,
        signal: ac.signal,
      })
    } catch {
      /* aborted — expected */
    } finally {
      clearTimeout(t)
    }
  }
  // if the gateway crashed on an unhandled rejection, this clean call fails
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
  const client = new Client({ name: 'survive-test', version: '1.0.0' })
  await client.connect(transport)
  type Reply = { content: Array<{ text: string }> }
  const reply = (await client.callTool({
    name: 'add',
    arguments: { a: 3, b: 4 },
  })) as Reply
  assert.strictEqual(reply.content[0].text, 'The sum of 3 and 4 is 7.')
  await client.close()
  await transport.close()
})
