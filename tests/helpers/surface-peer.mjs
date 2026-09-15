// A peer with the MCP surfaces nothing has tested: resources, resource
// templates, prompts, completion, and resource-update notifications.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const mcp = new McpServer(
  { name: 'surface-peer', version: '1.0.0' },
  {
    capabilities: {
      resources: { subscribe: true, listChanged: true },
      prompts: { listChanged: true },
      logging: {},
    },
  },
)

mcp.resource('note', 'note://alpha', async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'alpha-body' }],
}))

mcp.prompt('greet', { who: z.string() }, ({ who }) => ({
  messages: [{ role: 'user', content: { type: 'text', text: `hello ${who}` } }],
}))

mcp.tool('touch', {}, async () => {
  await mcp.server.sendResourceUpdated({ uri: 'note://alpha' })
  await mcp.server.sendResourceListChanged()
  await mcp.server.sendPromptListChanged()
  return { content: [{ type: 'text', text: 'touched' }] }
})

await mcp.connect(new StdioServerTransport())
