// A real SDK MCP peer with an intentionally noisy stdio boundary. The gateway
// must ignore blank/non-JSON stdout and keep stderr out of protocol responses.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { setTimeout } from 'node:timers/promises'

const server = new McpServer(
  { name: 'mock-server', version: '1.0.0' },
  {
    capabilities: { logging: {} },
  },
)
server.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: `The sum of ${a} and ${b} is ${a + b}.` }],
}))
server.tool('announce', {}, async () => {
  await server.sendLoggingMessage({ level: 'info', data: 'hello subscribers' })
  return { content: [{ type: 'text', text: 'announced' }] }
})
server.tool('delayed', {}, async () => {
  await setTimeout(100)
  return { content: [{ type: 'text', text: 'delayed result' }] }
})
server.tool('diagnostic', {}, async () => ({
  content: [{ type: 'text', text: 'completed with diagnostic data' }],
  // An extension field in a successful result is not a JSON-RPC error envelope.
  error: { code: 123, message: 'application diagnostic' },
}))
await server.connect(new StdioServerTransport())

process.stdout.write('\n  \r\npeer startup diagnostic (not JSON)\n')
process.stderr.write('peer stderr diagnostic\n')
