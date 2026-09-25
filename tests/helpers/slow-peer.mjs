// A peer with a tool that takes `ms` to finish unless it is cancelled, and a
// second tool that reports how the last slow call ended: running, aborted or
// completed. Lets a test see whether a cancellation reached the server.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const mcp = new McpServer({ name: 'slow-peer', version: '1.0.0' })
let last = 'none'

mcp.tool('slow', { ms: z.number() }, async ({ ms }, extra) => {
  last = 'running'
  const aborted = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    extra.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  last = aborted ? 'aborted' : 'completed'
  return { content: [{ type: 'text', text: last }] }
})

mcp.tool('status', {}, async () => ({
  content: [{ type: 'text', text: last }],
}))

await mcp.connect(new StdioServerTransport())
