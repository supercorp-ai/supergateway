// A remote MCP server for tests of remote entries served over HTTP: Streamable
// HTTP at /mcp and SSE at /sse, with a server of its own for every session,
// as a real remote server has.
//
// - `add` adds two numbers.
// - `whoami` returns the credentials the request reached it with, so a test
//   can see exactly what the gateway forwarded.
// - `ask` asks the client to sample, and returns what it answered: a request
//   from the server to the client, relayed back through the gateway.
// - GET /stats says how many sessions were opened and how many have closed,
//   and the x-team header the last SSE event stream was opened with.
// - A client named "refuse" has its initialize answered with an error, and
//   one named "slow" has it answered after a second.
//
// PORT selects the port; the first line on stdout is "listening <port>".
import express from 'express'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CreateMessageResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'

const stats = { opened: 0, closed: 0, sseTeam: null }

const newServer = () => {
  const server = new McpServer({ name: 'remote-server', version: '1.0.0' })
  server.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
  }))
  server.tool('whoami', {}, async (_args, extra) => {
    const headers = extra.requestInfo?.headers ?? {}
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            authorization: headers.authorization ?? null,
            'x-api-key': headers['x-api-key'] ?? null,
            'x-team': headers['x-team'] ?? null,
          }),
        },
      ],
    }
  })
  // Sent with the tool call it belongs to, as a server should: on that call's
  // own response stream. An unrelated request rides the session's GET stream,
  // which a client opens only after initializing and does not wait for, so a
  // tool called at once can find it not yet open (an SDK behaviour, the same
  // for a client connected directly).
  server.tool('ask', {}, async (_args, extra) => {
    const reply = await extra.sendRequest(
      {
        method: 'sampling/createMessage',
        params: {
          messages: [
            { role: 'user', content: { type: 'text', text: 'ping?' } },
          ],
          maxTokens: 10,
        },
      },
      CreateMessageResultSchema,
    )
    return {
      content: [{ type: 'text', text: `client said ${reply.content.text}` }],
    }
  })
  return server
}

const app = express()
app.use(express.json())

const streams = new Map()
app.all('/mcp', async (req, res) => {
  const id = req.headers['mcp-session-id']
  let transport = id ? streams.get(id) : undefined
  if (!transport) {
    // An initialize answered with an error, as a server that will not serve
    // this client answers it.
    if (req.body?.params?.clientInfo?.name === 'refuse') {
      res.json({
        jsonrpc: '2.0',
        id: req.body.id,
        error: { code: -32600, message: 'refused' },
      })
      return
    }
    // A server slow to start, for a client that gives up waiting.
    if (req.body?.params?.clientInfo?.name === 'slow')
      await new Promise((resolve) => setTimeout(resolve, 1000))
    if (req.method !== 'POST' || req.body?.method !== 'initialize') {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Session not found' },
        id: null,
      })
      return
    }
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        stats.opened++
        streams.set(sid, transport)
      },
    })
    transport.onclose = () => {
      if (streams.delete(transport.sessionId)) stats.closed++
    }
    await newServer().connect(transport)
  }
  await transport.handleRequest(req, res, req.body)
})

const events = new Map()
app.get('/sse', async (req, res) => {
  // What the event stream itself was opened with.
  stats.sseTeam = req.headers['x-team'] ?? null
  const transport = new SSEServerTransport('/message', res)
  events.set(transport.sessionId, transport)
  stats.opened++
  transport.onclose = () => {
    if (events.delete(transport.sessionId)) stats.closed++
  }
  await newServer().connect(transport)
})
app.post('/message', async (req, res) => {
  const transport = events.get(req.query.sessionId)
  if (!transport) {
    res.status(404).send('Session not found')
    return
  }
  await transport.handlePostMessage(req, res, req.body)
})

app.get('/stats', (_req, res) => {
  res.json(stats)
})

const server = app.listen(Number(process.env.PORT ?? 0), () => {
  console.log(`listening ${server.address().port}`)
})
