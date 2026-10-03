import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { unusedPort } from './helpers/gateway-process.js'

import { Client } from 'prev-modelcontextprotocol-sdk/client/index.js'
import { StdioClientTransport } from 'prev-modelcontextprotocol-sdk/client/stdio.js'

// A free port, not a fixed one: two suites on one machine (another worktree,
// another checkout) collided on it and hung.
const MCP_PORT = await unusedPort()
const MCP_URL = `http://localhost:${MCP_PORT}/sse`

let serverProc: ChildProcess | undefined

function spawnMcpServer(): Promise<ChildProcess> {
  return new Promise((res, rej) => {
    const proc = spawn('node', ['tests/helpers/mock-mcp-server.js', 'sse'], {
      env: { ...process.env, PORT: String(MCP_PORT) },
      shell: false,
      stdio: ['inherit', 'pipe', 'inherit'],
    })

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (chunk.includes('Server is running on port')) {
        res(proc)
      }
    })

    proc.on('error', rej)
  })
}

test.before(async () => {
  serverProc = await spawnMcpServer()
})

test.after(() => serverProc?.kill('SIGINT'))

test('protocol version is passed', async () => {
  const gatewayCmd = ['npm', 'run', 'start', '--', '--sse', MCP_URL]

  const transport = new StdioClientTransport({
    command: gatewayCmd[0],
    args: gatewayCmd.slice(1),
  })

  const client = new Client({ name: 'gateway-test', version: '1.0.0' })
  await client.connect(transport)

  const { tools } = await client.listTools()
  assert.ok(tools.some((t) => t.name === 'add'))

  type Reply = { content: Array<{ text: string }> }
  const reply = (await client.callTool({
    name: 'add',
    arguments: { a: 2, b: 3 },
  })) as Reply

  assert.strictEqual(reply.content[0].text, 'The sum of 2 and 3 is 5.')
  await client.close()
})
