import { Server, inputRequired } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

// An independent official-SDK server. No gateway code participates in its
// protocol selection, metadata handling, or multi-round-trip exchange.
serveStdio(
  ({ era }) => {
    const server = new Server(
      { name: 'transparent-sdk-peer', version: '1.0.0' },
      { capabilities: { tools: {}, resources: {}, logging: {} } },
    )
    const tool = (name) => ({
      name,
      inputSchema: { type: 'object', properties: {} },
    })
    server.setRequestHandler('tools/list', async () => ({
      tools: [tool('inspect'), tool('roots')],
    }))
    server.setRequestHandler('tools/call', async (request, ctx) => {
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
    server.fallbackRequestHandler = async (request) => ({
      echoed: request.params,
      extension: true,
    })
    return server
  },
  { legacy: process.argv.includes('--modern-only') ? 'reject' : 'serve' },
)
