// A peer that talks back: everything in MCP that travels server -> client.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const mcp = new McpServer(
  { name: 'reverse-peer', version: '1.0.0' },
  { capabilities: { logging: {}, tools: { listChanged: true } } },
)
const server = mcp.server

// Set by the tests that want the notifications spaced out rather than emitted
// back to back, to separate relay fidelity from a delivery race.
const SPACED = process.env.PROGRESS_SPACING === '1'

mcp.tool('log', {}, async () => {
  for (const level of ['info', 'warning', 'error']) {
    await server.sendLoggingMessage({ level, data: `log-${level}` })
  }
  return { content: [{ type: 'text', text: 'logged' }] }
})

mcp.tool('progress', {}, async (_args, extra) => {
  const token = extra?._meta?.progressToken
  for (let n = 1; n <= 3; n++) {
    await server.notification({
      method: 'notifications/progress',
      params: { progressToken: token, progress: n, total: 3 },
    })
    if (SPACED) await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return {
    content: [{ type: 'text', text: `progress-done token=${String(token)}` }],
  }
})

mcp.tool('toolsChanged', {}, async () => {
  await server.sendToolListChanged()
  return { content: [{ type: 'text', text: 'announced' }] }
})

mcp.tool('sample', {}, async () => {
  const reply = await server.createMessage({
    messages: [{ role: 'user', content: { type: 'text', text: 'ping' } }],
    maxTokens: 16,
  })
  const text =
    reply?.content?.type === 'text' ? reply.content.text : JSON.stringify(reply)
  return { content: [{ type: 'text', text: `sampled:${text}` }] }
})

mcp.tool('roots', {}, async () => {
  const reply = await server.listRoots()
  return {
    content: [
      {
        type: 'text',
        text: `roots:${(reply?.roots ?? []).map((r) => r.uri).join(',')}`,
      },
    ],
  }
})

mcp.tool('elicit', {}, async () => {
  const reply = await server.elicitInput({
    message: 'name?',
    requestedSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
    },
  })
  return {
    content: [
      {
        type: 'text',
        text: `elicited:${reply?.action}:${reply?.content?.name ?? ''}`,
      },
    ],
  }
})

await mcp.connect(new StdioServerTransport())
