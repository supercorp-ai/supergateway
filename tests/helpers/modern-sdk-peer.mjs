import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

serveStdio(() => {
  const server = new McpServer({ name: 'official-v2-stdio', version: '1.0.0' })
  server.registerTool('probe', {}, async () => ({
    content: [{ type: 'text', text: 'official SDK stdio result' }],
  }))
  return server
})
