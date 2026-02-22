import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger, MultiStdioServerConfig } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { randomUUID } from 'node:crypto'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'

interface StdioToStatefulStreamableHttpArgs {
  stdioCmd: string
  port: number
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  sessionTimeout: number | null
}

interface MultiStdioToStatefulStreamableHttpArgs {
  servers: MultiStdioServerConfig[]
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

const joinPath = (base: string, suffix: string) => {
  const normalizedBase = base === '/' ? '' : base.replace(/\/$/, '')
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${normalizedBase}${normalizedSuffix}` || '/'
}

export async function stdioToStatefulStreamableHttp(
  args: StdioToStatefulStreamableHttpArgs,
  app: express.Express,
) {
  const { stdioCmd, ...rest } = args

  return multiStdioToStatefulStreamableHttp(
    {
      ...rest,
      servers: [
        {
          path: '/',
          stdioCmd,
        },
      ],
    },
    app,
  )
}

export async function multiStdioToStatefulStreamableHttp(
  args: MultiStdioToStatefulStreamableHttpArgs,
  app: express.Express,
) {
  const {
    servers,
    port,
    streamableHttpPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    sessionTimeout,
  } = args

  logger.info(
    `  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  if (servers.length === 1 && servers[0]?.path === '/') {
    logger.info(`  - stdio: ${servers[0].stdioCmd}`)
    logger.info(`  - streamableHttpPath: ${streamableHttpPath}`)
  } else {
    logger.info('  - multi-server mappings:')
    for (const server of servers) {
      const fullPath = joinPath(server.path || '/', streamableHttpPath)
      logger.info(`    ${fullPath} -> ${server.stdioCmd}`)
    }
  }

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

  for (const serverConfig of servers) {
    const fullPath = joinPath(serverConfig.path || '/', streamableHttpPath)

    // Map to store transports by session ID
    const transports: { [sessionId: string]: StreamableHTTPServerTransport } =
      {}

    // Session access counter for timeout management
    const sessionCounter = sessionTimeout
      ? new SessionAccessCounter(
          sessionTimeout,
          (sessionId: string) => {
            logger.info(
              `Session ${sessionId} timed out, cleaning up (path ${fullPath})`,
            )
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
    app.post(fullPath, async (req, res) => {
      // Check for existing session ID
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      let transport: StreamableHTTPServerTransport

      if (sessionId && transports[sessionId]) {
        // Reuse existing transport
        transport = transports[sessionId]
        // Increment session access count
        sessionCounter?.inc(
          sessionId,
          `POST request for existing session (path ${fullPath})`,
        )
      } else if (!sessionId && isInitializeRequest(req.body)) {
        // New initialization request

        const server = new Server(
          { name: 'supergateway', version: getVersion() },
          { capabilities: {} },
        )

        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            // Store the transport by session ID
            transports[newSessionId] = transport
            // Initialize session access count
            sessionCounter?.inc(
              newSessionId,
              `session initialization (path ${fullPath})`,
            )
          },
        })
        await server.connect(transport)
        const child = spawn(serverConfig.stdioCmd, { shell: true })
        child.on('exit', (code, signal) => {
          logger.error(
            `Child exited (path ${fullPath}): code=${code}, signal=${signal}`,
          )
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
              logger.info(`Child → StreamableHttp (path ${fullPath}):`, line)
              try {
                transport.send(jsonMsg)
              } catch (e) {
                logger.error(
                  `Failed to send to StreamableHttp (path ${fullPath})`,
                  e,
                )
              }
            } catch {
              logger.error(`Child non-JSON (path ${fullPath}): ${line}`)
            }
          })
        })

        child.stderr.on('data', (chunk: Buffer) => {
          logger.error(
            `Child stderr (path ${fullPath}): ${chunk.toString('utf8')}`,
          )
        })

        transport.onmessage = (msg: JSONRPCMessage) => {
          logger.info(
            `StreamableHttp → Child (path ${fullPath}): ${JSON.stringify(msg)}`,
          )
          child.stdin.write(JSON.stringify(msg) + '\n')
        }

        transport.onclose = () => {
          logger.info(
            `StreamableHttp connection closed (session ${sessionId}, path ${fullPath})`,
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
          logger.error(
            `StreamableHttp error (session ${sessionId}, path ${fullPath}):`,
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
          logger.info(
            `Response ${event} (path ${fullPath})`,
            transport.sessionId,
          )
          sessionCounter?.dec(
            transport.sessionId,
            `POST response ${event} (path ${fullPath})`,
          )
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
      sessionCounter?.inc(
        sessionId,
        `${req.method} request for existing session (path ${fullPath})`,
      )

      // Decrement session access count when response ends
      let responseEnded = false
      const handleResponseEnd = (event: string) => {
        if (!responseEnded) {
          responseEnded = true
          logger.info(`Response ${event} (path ${fullPath})`, sessionId)
          sessionCounter?.dec(
            sessionId,
            `${req.method} response ${event} (path ${fullPath})`,
          )
        }
      }

      res.on('finish', () => handleResponseEnd('finished'))
      res.on('close', () => handleResponseEnd('closed'))

      const transport = transports[sessionId]
      await transport.handleRequest(req, res)
    }

    // Handle GET requests for server-to-client notifications via SSE
    app.get(fullPath, handleSessionRequest)

    // Handle DELETE requests for session termination
    app.delete(fullPath, handleSessionRequest)
  }

  if (servers.length === 1 && servers[0]?.path === '/') {
    logger.info(
      `StreamableHttp endpoint: http://localhost:${port}${streamableHttpPath}`,
    )
  } else {
    for (const serverConfig of servers) {
      const fullPath = joinPath(serverConfig.path || '/', streamableHttpPath)
      logger.info(
        `StreamableHttp endpoint: http://localhost:${port}${fullPath}`,
      )
    }
  }
}
