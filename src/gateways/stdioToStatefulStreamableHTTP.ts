import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { randomUUID } from 'node:crypto'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

export interface StdioToStreamableHTTPArgs {
  stdioCmd: string
  port: number
  streamableHTTPPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  sessionTimeout: number | null
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

export async function stdioToStatefulStreamableHTTP(
  args: StdioToStreamableHTTPArgs,
) {
  const {
    stdioCmd,
    port,
    streamableHTTPPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    sessionTimeout,
  } = args

  logger.info(
    `  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - streamableHTTPPath: ${streamableHTTPPath}`)

  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )
  logger.info(
    `  - Session timeout: ${sessionTimeout ? `${sessionTimeout}ms` : 'disabled'}`,
  )

  onSignals({ logger })

  const app = express()
  app.use(express.json())

  if (corsOrigin) {
    app.use(
      cors({
        origin: corsOrigin,
        exposedHeaders: ['Mcp-Session-Id'],
      }),
    )
  }

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  // Map to store transports by session ID
  const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {}

  // Map to store timeout handles for each session
  const sessionTimeouts: { [sessionId: string]: NodeJS.Timeout } = {}

  const clearSessionTimeout = (sessionId: string, reason: string) => {
    logger.info(
      `Clearing timeout for session ${sessionId}, caused by ${reason}`,
    )
    if (sessionTimeouts[sessionId]) {
      clearTimeout(sessionTimeouts[sessionId])
      delete sessionTimeouts[sessionId]
    }
  }

  const setSessionTimeout = (sessionId: string) => {
    if (!sessionTimeout) return

    clearSessionTimeout(sessionId, 'resetting timeout') // Clear any existing timeout

    sessionTimeouts[sessionId] = setTimeout(() => {
      logger.info(`Session ${sessionId} timed out, cleaning up`)
      const transport = transports[sessionId]
      if (transport) {
        transport.close()
      }
      delete sessionTimeouts[sessionId]
    }, sessionTimeout)
  }

  // Handle POST requests for client-to-server communication
  app.post(streamableHTTPPath, async (req, res) => {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId]
      // Clear any existing timeout since session is active
      clearSessionTimeout(
        sessionId,
        'receiving new request for existing session',
      )
    } else if (!sessionId && isInitializeRequest(req.body)) {
      // New initialization request

      const server = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID
          transports[sessionId] = transport
        },
      })
      await server.connect(transport)
      const child = spawn(stdioCmd, { shell: true })
      child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        transport.close()
      })

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        lines.forEach((line) => {
          if (!line.trim()) return
          try {
            const jsonMsg = JSON.parse(line)
            logger.info('Child → StreamableHTTP:', line)
            try {
              transport.send(jsonMsg)
            } catch (e) {
              logger.error(`Failed to send to StreamableHTTP`, e)
            }
          } catch {
            logger.error(`Child non-JSON: ${line}`)
          }
        })
      })

      child.stderr.on('data', (chunk: Buffer) => {
        logger.error(`Child stderr: ${chunk.toString('utf8')}`)
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(`StreamableHTTP → Child: ${JSON.stringify(msg)}`)
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        logger.info(`StreamableHTTP connection closed (session ${sessionId})`)
        if (transport.sessionId) {
          clearSessionTimeout(transport.sessionId, 'transport being closed')
          delete transports[transport.sessionId]
        }
        child.kill()
      }

      transport.onerror = (err) => {
        logger.error(`StreamableHTTP error (session ${sessionId}):`, err)
        if (transport.sessionId) {
          clearSessionTimeout(transport.sessionId, 'transport emitting error')
          delete transports[transport.sessionId]
        }
        child.kill()
      }
    } else {
      // Invalid request
      res.status(400).json({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Bad Request: No valid session ID provided',
        },
        id: null,
      })
      return
    }

    // Set timeout when response ends
    res.on('finish', () => {
      logger.info('Response finished', transport.sessionId)
      if (transport.sessionId) {
        setSessionTimeout(transport.sessionId)
      }
    })
    res.on('close', () => {
      logger.info('Response closed', transport.sessionId)
      if (transport.sessionId) {
        setSessionTimeout(transport.sessionId)
      }
    })

    // Handle the request
    await transport.handleRequest(req, res, req.body)
  })

  // Reusable handler for GET and DELETE requests
  const handleSessionRequest = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID')
      return
    }

    // Clear any existing timeout since session is active
    clearSessionTimeout(sessionId, 'receiving new request for existing session')

    // Set timeout when response ends
    res.on('finish', () => {
      logger.info('Response finished', transport.sessionId)
      setSessionTimeout(sessionId)
    })
    res.on('close', () => {
      logger.info('Response closed', transport.sessionId)
      setSessionTimeout(sessionId)
    })

    const transport = transports[sessionId]
    await transport.handleRequest(req, res)
  }

  // Handle GET requests for server-to-client notifications via SSE
  app.get(streamableHTTPPath, handleSessionRequest)

  // Handle DELETE requests for session termination
  app.delete(streamableHTTPPath, handleSessionRequest)

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(
      `StreamableHTTP endpoint: http://localhost:${port}${streamableHTTPPath}`,
    )
  })
}
