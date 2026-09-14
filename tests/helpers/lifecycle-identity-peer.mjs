// The server metadata exposes this fixture's own PID so tests can distinguish
// a terminated stdio process from merely closed protocol/socket connections.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({
  name: 'lifecycle-identity-peer',
  version: String(process.pid),
})
server.tool('ping', {}, async () => ({
  content: [{ type: 'text', text: 'pong' }],
}))
await server.connect(new StdioServerTransport())
