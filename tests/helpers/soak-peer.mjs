// The server behind the soak scenarios: one tool per behaviour the soak
// repeats for hours. Log messages and progress, a sampling request back to the
// client, a slow call that honours cancellation, a large reply, and a crash in
// the middle of a call.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const mcp = new McpServer(
  { name: 'soak-peer', version: '1.0.0' },
  { capabilities: { logging: {} } },
)
const server = mcp.server
const text = (value) => ({ content: [{ type: 'text', text: value }] })

// Spaced, because the MCP TypeScript SDK *client* drops progress that arrives
// in the same read as the result (GW-027): even a direct stdio connection with
// no gateway loses it. The soak is here to test the gateway, not that.
const gap = () => new Promise((resolve) => setTimeout(resolve, 15))

mcp.tool('chatty', { tag: z.string() }, async ({ tag }, extra) => {
  const token = extra._meta?.progressToken
  for (let step = 1; step <= 3; step++) {
    await server.sendLoggingMessage({ level: 'info', data: `${tag}:${step}` })
    if (token !== undefined)
      await server.notification({
        method: 'notifications/progress',
        params: { progressToken: token, progress: step, total: 3 },
      })
    await gap()
  }
  return text(`chatty:${tag}`)
})

mcp.tool('sample', { tag: z.string() }, async ({ tag }) => {
  const reply = await server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text: tag } }],
    maxTokens: 8,
  })
  return text(`sampled:${reply.content.text}`)
})

mcp.tool('slow', { ms: z.number() }, async ({ ms }, extra) => {
  const cancelled = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms)
    extra.signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
  return text(cancelled ? 'cancelled' : 'finished')
})

mcp.tool('big', { bytes: z.number() }, async ({ bytes }) =>
  text('b'.repeat(bytes)),
)

mcp.tool('crash', {}, async () => {
  setTimeout(() => process.exit(3), 10)
  return new Promise(() => {})
})

await mcp.connect(new StdioServerTransport())
