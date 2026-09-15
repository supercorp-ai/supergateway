// Real SDK peer: PID and a counter distinguish session continuity from a
// replacement child that merely answers the same tools/list request.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

let calls = 0
const server = new McpServer({
  name: 'session-state',
  version: String(process.pid),
})
server.tool('step', {}, async () => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify({ pid: process.pid, calls: ++calls }),
    },
  ],
}))
await server.connect(new StdioServerTransport())
