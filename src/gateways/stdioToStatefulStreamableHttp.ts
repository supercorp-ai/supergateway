import { spawn } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { createModernHttp } from '../lib/modernHttp.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { randomUUID } from 'node:crypto'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'
import { describeHeaders } from '../lib/headers.js'

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

  logger.info(`  - Headers: ${describeHeaders(headers)}`)
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

  const children = new OwnedChildProcesses(logger)
  const modern = createModernHttp({ stdioCmd, children, logger })
  onSignals({
    logger,
    cleanup: async () => {
      await Promise.all([modern.close(), children.close()])
    },
    drainStdin: true,
  })

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

  // A real Map, not an object. A plain object's keys are looked up through
  // `Object.prototype`, so an unissued session id like `toString` or
  // `constructor` resolves to an inherited function and is then used as a
  // transport — every name on that prototype crashed the gateway, from an
  // ordinary HTTP header, before any session existed. A Map has no such
  // inheritance, which fixes the class rather than the names.
  const transports = new Map<string, StreamableHTTPServerTransport>()

  // Session access counter for timeout management
  const sessionCounter = sessionTimeout
    ? new SessionAccessCounter(
        sessionTimeout,
        (sessionId: string) => {
          logger.info(`Session ${sessionId} timed out, cleaning up`)
          // Reached only from the idle timer, and every path that removes a
          // transport cancels that timer first: both `clear()` call sites pass
          // `runCleanup: false`, so this callback never runs for a session that
          // has already gone. The presence check could not be false.
          //
          // Still async, and still running from a timer with nothing above it,
          // so the rejection handler stays — a cleanup path is the worst place
          // to crash.
          const transport = transports.get(sessionId)!
          transport.close().catch((err) => {
            logger.error(`Failed to close timed-out session ${sessionId}`, err)
          })
          transports.delete(sessionId)
        },
        logger,
      )
    : null

  // Handle POST requests for client-to-server communication
  app.post(streamableHttpPath, async (req, res) => {
    if (children.closing) {
      res.status(503).send('Gateway is shutting down')
      return
    }
    if (await modern.handle(req, res)) return
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports.has(sessionId)) {
      // Reuse existing transport
      transport = transports.get(sessionId)!
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
          transports.set(sessionId, transport)
          // Initialize session access count
          sessionCounter?.inc(sessionId, 'session initialization')
        },
      })
      await server.connect(transport)
      const child = spawn(stdioCmd, children.spawnOptions)
      const stop = children.own(child)
      const pendingRequests = new Set<string | number>()
      let childStopped = false
      const stopChild = (reason: string) => {
        if (childStopped) return
        childStopped = true
        if (transport.sessionId) {
          sessionCounter?.clear(transport.sessionId, false, reason)
          transports.delete(transport.sessionId)
        }
        void stop()
      }
      let childFailed = false
      const handleChildFailure = (err?: Error) => {
        // Exit, ChildProcess errors and stdin errors can arrive for the same
        // child. Keep listeners installed and terminate this transport once.
        if (childFailed) return
        childFailed = true
        if (err) logger.error('Child process failure:', err)
        stopChild('child process failure')
        // Ending an SSE response alone leaves SDK clients waiting for their
        // request timeout. Fail each outstanding call before closing streams.
        const replies = [...pendingRequests].map((id) =>
          transport
            .send({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: 'MCP server process failed' },
            })
            .catch((sendError) => {
              logger.error('Failed to send child failure', sendError)
            }),
        )
        pendingRequests.clear()
        void Promise.all(replies)
          .then(() => transport.close())
          .catch((closeError) => {
            logger.error(
              'Failed to close transport after child failure',
              closeError,
            )
          })
          .finally(() => {
            // A spawn failure can precede SDK response registration. Do not
            // destroy a completed response: its error frame must flush first.
            if (!res.writableEnded) res.destroy()
          })
      }
      child.on('error', handleChildFailure)
      child.stdin.on('error', handleChildFailure)
      child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        // HTTP EOF alone does not settle an SDK request. Use the same
        // idempotent error delivery as spawn/stdin failure before closing.
        handleChildFailure()
      })

      const decoder = new StringDecoder('utf8')
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk)
        const lines = buffer.split(/\r?\n/)
        // `split` always returns at least one element, so `pop()` is never
        // undefined here — the fallback it replaced could not be taken.
        buffer = lines.pop()!
        lines.forEach((line) => {
          if (!line.trim()) return
          try {
            const jsonMsg = JSON.parse(line)
            logger.info('Child → StreamableHttp:', line)
            if ('id' in jsonMsg && !('method' in jsonMsg)) {
              pendingRequests.delete(jsonMsg.id)
            }
            transport
              .send(jsonMsg, {
                // A message with no related request is routed to the standalone
                // GET stream, and the SDK returns silently when that stream is
                // not connected yet — so nothing throws and the notification is
                // simply gone. That window is exactly the start of a call, which
                // is where a tool emits its first progress notification: soak run
                // 35410255256 lost `progress: 1` and kept 2 and 3. Responses
                // route by their own id regardless; everything else rides the
                // request in flight, as the stateless bridge already does.
                relatedRequestId: pendingRequests.values().next().value,
              })
              .catch((e) => {
                logger.error(`Failed to send to StreamableHttp`, e)
              })
          } catch {
            logger.error(`Child non-JSON: ${line}`)
          }
        })
      })

      child.stderr.on('data', (chunk: Buffer) => {
        logger.error(`Child stderr: ${chunk.toString('utf8')}`)
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        if ('id' in msg && 'method' in msg) pendingRequests.add(msg.id!)
        logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        logger.info(`StreamableHttp connection closed (session ${sessionId})`)
        stopChild('transport being closed')
      }

      transport.onerror = (err) => {
        logger.error(`StreamableHttp error (session ${sessionId}):`, err)
        // A rejected HTTP request is recoverable; actual transport closure
        // and child failure have their own cleanup paths.
      }
    } else if (sessionId) {
      // A session id we no longer hold: terminated by DELETE, reaped by
      // --sessionTimeout, or lost across a gateway restart. The spec requires
      // 404 here, and that 404 is the only signal that makes a compliant
      // client open a new session:
      //
      //   "The server MAY terminate the session at any time, after which it
      //    MUST respond to requests containing that session ID with HTTP 404
      //    Not Found. When a client receives HTTP 404 in response to a request
      //    containing an Mcp-Session-Id, it MUST start a new session by
      //    sending a new InitializeRequest without a session ID attached."
      //
      // Answering 400 leaves the client replaying a dead id forever.
      res.status(404).json({
        jsonrpc: '2.0',
        error: {
          code: -32001,
          message: 'Session not found',
        },
        id: null,
      })
      return
    } else {
      // No session id at all, and not an initialize request. This one stays
      // 400: the spec asks for 400 when the header is absent, and a client
      // that never had a session has nothing to re-initialize away from.
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
    if (!sessionId) {
      res.status(400).send('Invalid or missing session ID')
      return
    }
    if (!transports.has(sessionId)) {
      // Unknown session id -> 404 so the client re-initializes instead of
      // retrying a dead id. See the POST handler above for the spec citation.
      res.status(404).send('Session not found')
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

    const transport = transports.get(sessionId)!
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
