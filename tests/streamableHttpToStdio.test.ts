import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const MCP_PORT = 11002
const MCP_URL = `http://localhost:${MCP_PORT}/mcp`

let serverProc: ChildProcess | undefined

function spawnMcpServer(): Promise<ChildProcess> {
  return new Promise((res, rej) => {
    const proc = spawn(
      `PORT=${MCP_PORT} npx -y @modelcontextprotocol/server-everything streamableHttp`,
      { shell: true, stdio: ['inherit', 'pipe', 'inherit'] },
    )

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      if (chunk.includes('MCP Streamable HTTP Server listening')) {
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

test('streamableHttpToStdio listTools and callTool', async () => {
  const gatewayCmd = [
    'node',
    '--loader',
    'ts-node/esm',
    '--input-type=module',
    '-e',
    `
      import { streamableHttpToStdio as g } from
        '${pathToFileURL(path.resolve('src/gateways/streamableHttpToStdio.ts'))}';
      import { getLogger } from
        '${pathToFileURL(path.resolve('src/lib/getLogger.ts'))}';

      await g({
        streamableHttpUrl: '${MCP_URL}',
        logger: getLogger({ logLevel: 'info', outputTransport: 'stdio' }),
        headers: {},
      });
      process.stdin.resume();
    `,
  ]

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
