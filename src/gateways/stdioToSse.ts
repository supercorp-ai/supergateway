import express from 'express'
import bodyParser from 'body-parser'
import cors, { type CorsOptions } from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { RequestHandler } from 'express'

export interface StdioToSseArgs {
  stdioCmd: string
  port: number
  baseUrl: string
  ssePath: string
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  headersPassthrough: string[]
}

const setResponseHeaders = ({
  res,
  headers,
}: {
  res: express.Response
  headers: Record<string, string>
}) =>
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

export async function stdioToSse(args: StdioToSseArgs) {
  const {
    stdioCmd,
    port,
    baseUrl,
    ssePath,
    messagePath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    headersPassthrough,
  } = args

  logger.info(
    `  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  if (baseUrl) {
    logger.info(`  - baseUrl: ${baseUrl}`)
  }
  logger.info(`  - ssePath: ${ssePath}`)
  logger.info(`  - messagePath: ${messagePath}`)

  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  const sessions: Record<
    string,
    {
      transport: SSEServerTransport
      response: express.Response
      child: ChildProcessWithoutNullStreams
    }
  > = {}

  const app = express()

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  app.use((req, res, next) => {
    if (req.path === messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  app.get(ssePath, async (req, res) => {
    logger.info(`New SSE connection from ${req.ip}`)

    setResponseHeaders({
      res,
      headers,
    })

    // Capture headers and build child environment
    const passthroughEnv: Record<string, string> = {}
    for (const headerName of headersPassthrough) {
      const headerValue = req.header(headerName)
      if (headerValue != null) {
        const envKey =
          'HEADER_' + headerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')
        passthroughEnv[envKey] = headerValue
      }
    }
    const childEnv = { ...process.env, ...passthroughEnv }

    // Spawn child process for this session
    const child = spawn(stdioCmd, { shell: true, env: childEnv })

    // Create a dedicated MCP server for this session
    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )
    const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)
    await server.connect(sseTransport)

    const sessionId = sseTransport.sessionId as string
    sessions[sessionId] = { transport: sseTransport, response: res, child }

    // Handle child exit
    child.on('exit', (code, signal) => {
      logger.error(
        `Child exited (session ${sessionId}): code=${code}, signal=${signal}`,
      )
      delete sessions[sessionId]
    })

    // Forward SSE → child stdin
    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      logger.info(`SSE → Child (session ${sessionId}): ${JSON.stringify(msg)}`)
      child.stdin.write(JSON.stringify(msg) + '\n')
    }
    sseTransport.onclose = () => {
      logger.info(`SSE connection closed (session ${sessionId})`)
      child.kill()
      delete sessions[sessionId]
    }
    sseTransport.onerror = (err) => {
      logger.error(`SSE error (session ${sessionId}):`, err)
      child.kill()
      delete sessions[sessionId]
    }
    req.on('close', () => {
      logger.info(`Client disconnected (session ${sessionId})`)
      child.kill()
      delete sessions[sessionId]
    })

    // Forward child stdout → SSE
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          const jsonMsg = JSON.parse(line)
          logger.info(
            `Child → SSE (session ${sessionId}): ${JSON.stringify(jsonMsg)}`,
          )
          sseTransport.send(jsonMsg)
        } catch {
          logger.error(`Child non-JSON: ${line}`)
        }
      }
    })
    child.stderr.on('data', (chunk: Buffer) => {
      logger.error(`Child stderr: ${chunk.toString('utf8')}`)
    })
  })

  // Handle POST messages per session
  app.post(messagePath, (async (req, res, next) => {
    const sessionId = req.query.sessionId as string
    setResponseHeaders({ res, headers })
    if (!sessionId) {
      return res.status(400).send('Missing sessionId parameter')
    }
    const session = sessions[sessionId]
    if (session?.transport?.handlePostMessage) {
      logger.info(`POST to SSE transport (session ${sessionId})`)
      await session.transport.handlePostMessage(req, res)
    } else {
      res.status(503).send(`No active SSE connection for session ${sessionId}`)
    }
  }) as RequestHandler)

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`)
    logger.info(`POST messages: http://localhost:${port}${messagePath}`)
  })
}
