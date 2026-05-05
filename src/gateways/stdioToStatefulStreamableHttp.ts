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
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'

// The MCP SDK's stateful streamable HTTP transport raises some errors via
// `transport.onerror` that are recoverable at the HTTP layer — the SDK still
// returns a proper 4xx response to the client. The most common one is a
// duplicate `GET /mcp` for an already-active standalone SSE stream, which is
// triggered routinely whenever a client (e.g. Claude Code) reconnects without
// an explicit `DELETE`. Treating these as fatal would SIGTERM the stdio child
// and destroy session-scoped state for every reconnect — see issue #126.
const RECOVERABLE_TRANSPORT_ERROR_MESSAGES: readonly string[] = [
  'Conflict: Only one SSE stream is allowed per session',
]

function isRecoverableTransportError(err: unknown): boolean {
  return (
    err instanceof Error &&
    RECOVERABLE_TRANSPORT_ERROR_MESSAGES.includes(err.message)
  )
}

export interface StdioToStreamableHttpArgs {
  stdioCmd: string
  port: number
  streamableHttpPath: string
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

export async function stdioToStatefulStreamableHttp(
  args: StdioToStreamableHttpArgs,
) {
  const {
    stdioCmd,
    port,
    streamableHttpPath,
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
  logger.info(`  - streamableHttpPath: ${streamableHttpPath}`)

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

  // Session access counter for timeout management
  const sessionCounter = sessionTimeout
    ? new SessionAccessCounter(
        sessionTimeout,
        (sessionId: string) => {
          logger.info(`Session ${sessionId} timed out, cleaning up`)
          const transport = transports[sessionId]
          if (transport) {
            transport.close()
          }
          delete transports[sessionId]
        },
        logger,
      )
    : null

  // Handle POST requests for client-to-server communication
  app.post(streamableHttpPath, async (req, res) => {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId]
      // Increment session access count
      sessionCounter?.inc(sessionId, 'POST request for existing session')
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
          // Initialize session access count
          sessionCounter?.inc(sessionId, 'session initialization')
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
            logger.info('Child → StreamableHttp:', line)
            try {
              transport.send(jsonMsg)
            } catch (e) {
              logger.error(`Failed to send to StreamableHttp`, e)
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
        logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        logger.info(
          `StreamableHttp connection closed (session ${transport.sessionId ?? '<pre-init>'})`,
        )
        if (transport.sessionId) {
          sessionCounter?.clear(
            transport.sessionId,
            false,
            'transport being closed',
          )
          delete transports[transport.sessionId]
        }
        child.kill()
      }

      transport.onerror = (err) => {
        // Some SDK errors are surfaced via onerror but are recoverable at the
        // HTTP layer (the SDK still returns a 4xx). Tearing down the session
        // and SIGTERMing the child for those would destroy session state on
        // every routine client reconnect — see issue #126.
        if (isRecoverableTransportError(err)) {
          logger.info(
            `StreamableHttp recoverable error (session ${transport.sessionId ?? '<pre-init>'}): ${(err as Error).message}`,
          )
          return
        }
        logger.error(
          `StreamableHttp error (session ${transport.sessionId ?? '<pre-init>'}):`,
          err,
        )
        if (transport.sessionId) {
          sessionCounter?.clear(
            transport.sessionId,
            false,
            'transport emitting error',
          )
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

    // Decrement session access count when response ends
    let responseEnded = false
    const handleResponseEnd = (event: string) => {
      if (!responseEnded && transport.sessionId) {
        responseEnded = true
        logger.info(`Response ${event}`, transport.sessionId)
        sessionCounter?.dec(transport.sessionId, `POST response ${event}`)
      }
    }

    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))

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

    // Increment session access count
    sessionCounter?.inc(sessionId, `${req.method} request for existing session`)

    // Decrement session access count when response ends
    let responseEnded = false
    const handleResponseEnd = (event: string) => {
      if (!responseEnded) {
        responseEnded = true
        logger.info(`Response ${event}`, sessionId)
        sessionCounter?.dec(sessionId, `${req.method} response ${event}`)
      }
    }

    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))

    const transport = transports[sessionId]
    await transport.handleRequest(req, res)
  }

  // Handle GET requests for server-to-client notifications via SSE
  app.get(streamableHttpPath, handleSessionRequest)

  // Handle DELETE requests for session termination
  app.delete(streamableHttpPath, handleSessionRequest)

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(
      `StreamableHttp endpoint: http://localhost:${port}${streamableHttpPath}`,
    )
  })
}
