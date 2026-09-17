import { Server, inputRequired } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

// An independent official-SDK server. No gateway code participates in its
// protocol selection, metadata handling, or multi-round-trip exchange.
serveStdio(
  ({ era }) => {
    const server = new Server(
      { name: 'transparent-sdk-peer', version: '1.0.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: {},
          logging: {},
        },
      },
    )
    const tool = (name) => ({
      name,
      inputSchema: { type: 'object', properties: {} },
    })
    server.setRequestHandler('tools/list', async () => ({
      tools: [tool('inspect'), tool('roots'), tool('logs')],
    }))
    server.setRequestHandler('tools/call', async (request, ctx) => {
      if (request.params.name === 'logs') {
        await ctx.mcpReq.notify({
          method: 'notifications/message',
          params: { level: 'info', data: 'visible log' },
        })
        return { content: [{ type: 'text', text: 'logged' }] }
      }
      if (request.params.name === 'roots') {
        const roots = ctx.mcpReq.inputResponses?.locations
        if (!roots)
          return inputRequired({
            inputRequests: { locations: { method: 'roots/list', params: {} } },
            requestState: 'opaque-state:α/+=',
          })
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ roots, state: ctx.mcpReq.requestState() }),
            },
          ],
        }
      }
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              era,
              meta: request.params._meta,
              envelope: ctx.mcpReq.envelope,
              arguments: request.params.arguments,
            }),
          },
        ],
      }
    })
    server.setRequestHandler('resources/read', async (request) => ({
      contents: [{ uri: request.params.uri, text: 'resource body' }],
    }))
    const timer = setInterval(() => {
      void server.sendToolListChanged().catch(() => {})
    }, 80)
    timer.unref()
    server.onclose = () => clearInterval(timer)
    return server
  },
  { legacy: process.argv.includes('--modern-only') ? 'reject' : 'serve' },
)
