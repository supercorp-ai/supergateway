// Real SDK peer. A separate local HTTP connection lets the test release a
// running tool or stop this process after observing the request in flight.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const controlUrl = process.argv[2]
const server = new McpServer({ name: 'lifecycle-peer', version: '1.0.0' })
const action = async () => {
  const response = await fetch(controlUrl)
  const command = await response.text()
  if (command === 'exit') process.exit(17)
}
server.tool('hold', {}, async () => {
  await action()
  return { content: [{ type: 'text', text: 'held result' }] }
})
server.tool('armExit', {}, async () => {
  void action().catch(() => {}) // Teardown may close the control connection.
  return { content: [{ type: 'text', text: 'exit armed' }] }
})
await server.connect(new StdioServerTransport())
