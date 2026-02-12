import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { execSync } from 'node:child_process'

const PORT = 11015
const MCP_URL = `http://localhost:${PORT}/mcp`

let gatewayProc: ChildProcess

function countMockStdioProcesses(): number {
  const out = execSync('ps ax -o command=', { encoding: 'utf8' })
  return out
    .split('\n')
    .filter((l) => l.includes('mock-mcp-server.js stdio'))
    .filter((l) => !l.includes('ps ax -o command='))
    .filter(Boolean).length
}

test.before(async () => {
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

  // Give the gateway time to start listening.
  await new Promise((r) => setTimeout(r, 2000))
})

test.after(async () => {
  gatewayProc.kill('SIGINT')
  await new Promise((resolve) => gatewayProc.once('exit', resolve))
})

test('stateless streamableHttp does not leak child processes across requests', async () => {
  const baseline = countMockStdioProcesses()
  assert.ok(baseline >= 1)

  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
  const client = new Client({
    name: 'stateless-cleanup-test',
    version: '1.0.0',
  })
  await client.connect(transport)

  for (let i = 0; i < 10; i++) {
    const { tools } = await client.listTools()
    assert.ok(tools.some((t) => t.name === 'add'))

    await client.callTool({
      name: 'add',
      arguments: { a: i, b: i + 1 },
    })

    // Let cleanup hooks run.
    await new Promise((r) => setTimeout(r, 200))

    const now = countMockStdioProcesses()
    assert.strictEqual(now, baseline)
  }

  await client.close()
  transport.close()
})
