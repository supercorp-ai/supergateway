import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const PORT = 11006
const BASE_URL = `http://0.0.0.0:${PORT}`

async function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function runMultiServerScenario(args: string[]) {
  const gatewayProc: ChildProcess = spawn(
    'npm',
    ['run', 'start', '--', ...args],
    { stdio: 'ignore', shell: false },
  )
  gatewayProc.unref()

  try {
    // Give the gateway some time to boot
    await wait(2000)

    const paths = ['/git/mcp', '/docker/mcp']

    for (const path of paths) {
      const transport = new StreamableHTTPClientTransport(
        new URL(path, BASE_URL),
      )
      const client = new Client({ name: 'multi-test', version: '1.0.0' })

      await client.connect(transport)

      const { tools } = await client.listTools()
      assert.ok(
        tools.some((t) => t.name === 'add'),
        `tools should include add for path ${path}`,
      )

      type Reply = { content: Array<{ text: string }> }
      const reply = (await client.callTool({
        name: 'add',
        arguments: { a: 1, b: 2 },
      })) as Reply

      assert.strictEqual(reply.content[0].text, 'The sum of 1 and 2 is 3.')

      await client.close()
      transport.close()
    }
  } finally {
    gatewayProc.kill('SIGINT')
    await new Promise((resolve) => gatewayProc.once('exit', resolve))
  }
}

test('multi-server via --multiServerConfig', async () => {
  await runMultiServerScenario([
    '--multiServerConfig',
    'tests/fixtures/multi-server.json',
    '--outputTransport',
    'streamableHttp',
    '--port',
    String(PORT),
    '--streamableHttpPath',
    '/mcp',
  ])
})

test('multi-server via --stdio name=command', async () => {
  await runMultiServerScenario([
    '--stdio',
    'git=node tests/helpers/mock-mcp-server.js stdio',
    '--stdio',
    'docker=node tests/helpers/mock-mcp-server.js stdio',
    '--outputTransport',
    'streamableHttp',
    '--port',
    String(PORT),
    '--streamableHttpPath',
    '/mcp',
  ])
})
