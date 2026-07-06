import express from 'express'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'

const mode = process.argv[2]
const port = Number(process.env.PORT || 3000)

const server = new McpServer({ name: 'mock-server', version: '1.0.0' })

server.tool('add', { a: z.number(), b: z.number() }, async ({ a, b }) => ({
  content: [{ type: 'text', text: `The sum of ${a} and ${b} is ${a + b}.` }],
}))

// Test hook for the per-request reap: spawn one DETACHED sleeper (setsid → its
// own session, must SURVIVE the reap) and one IN-SESSION sleeper (inherits this
// request's session, must be REAPED). Returns both PIDs so the test can assert.
server.tool('spawn_probe', {}, async () => {
  const detached = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
  detached.unref()
  const inSession = spawn('sleep', ['30'], { stdio: 'ignore' })
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          detachedPid: detached.pid,
          inSessionPid: inSession.pid,
        }),
      },
    ],
  }
})

if (mode === 'stdio') {
  const transport = new StdioServerTransport()
  await server.connect(transport)
} else if (mode === 'sse') {
  const app = express()
  app.use(express.json())
  const transports = {}

  app.get('/sse', async (req, res) => {
    const transport = new SSEServerTransport('/message', res)
    const sid = transport.sessionId
    transports[sid] = transport
    transport.onclose = () => {
      delete transports[sid]
    }
    await server.connect(transport)
  })

  app.post('/message', async (req, res) => {
    const sessionId = req.query.sessionId
    const transport = transports[sessionId]
    if (!transport) {
      res.status(404).send('Session not found')
      return
    }
    await transport.handlePostMessage(req, res, req.body)
  })

  app.listen(port, () => {
    console.log(`Server is running on port ${port}`)
  })
} else if (mode === 'streamableHttp') {
  const app = express()
  app.use(express.json())

  const transports = {}

  app.all('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id']
    let transport = sessionId ? transports[sessionId] : undefined

    if (!transport) {
      if (req.method === 'POST' && req.body?.method === 'initialize') {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports[sid] = transport
          },
        })
        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid) delete transports[sid]
        }
        await server.connect(transport)
      } else {
        res.status(400).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: Server not initialized',
          },
          id: null,
        })
        return
      }
    }

    await transport.handleRequest(req, res, req.body)
  })

  app.listen(port, () => {
    console.log(`MCP Streamable HTTP Server listening on port ${port}`)
  })
} else {
  console.error('Unknown mode: ' + mode)
  process.exit(1)
}
