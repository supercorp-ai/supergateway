import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { randomUUID } from 'node:crypto'
import {
  isInitializeRequest,
  SUPPORTED_PROTOCOL_VERSIONS,
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js'
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'

export interface StdioToSharedStreamableHttpArgs {
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

/**
 * Runs a single stdio MCP server process and exposes it over Streamable HTTP
 * to any number of concurrent client sessions. Unlike stdioToStatefulStreamableHttp
 * (one child process per session), this mode spawns exactly ONE child process for
 * the lifetime of the gateway and multiplexes every session's requests onto it.
 *
 * This exists for upstream servers that only tolerate a single client connection.
 * Only the first session to connect performs the real initialize/initialized
 * handshake against the child; every later session gets a synthesized initialize
 * response (cached from that handshake) and is transparently multiplexed onto the
 * same child afterwards via JSON-RPC id rewriting.
 */
export async function stdioToSharedStreamableHttp(
  args: StdioToSharedStreamableHttpArgs,
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
  logger.info(
    `  - Mode: shared (one child process, N client sessions multiplexed onto it)`,
  )

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
      setResponseHeaders({ res, headers })
      res.send('ok')
    })
  }

  app.use((req, _res, next) => {
    logger.info(
      `HTTP ${req.method} ${req.path} session=${req.headers['mcp-session-id']} protocolVersion=${req.headers['mcp-protocol-version']} accept=${req.headers['accept']}`,
    )
    next()
  })

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

  // --- Single shared child process, spawned once for the whole gateway ---

  let child: ChildProcessWithoutNullStreams
  let childExited = false

  // Pending requests we've forwarded to the child, keyed by the id we rewrote
  // them to. Resolved when a matching response line arrives on the child's stdout.
  const pending = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport
      originalId: string | number
      isInitialize?: boolean
      requestedProtocolVersion?: string
    }
  >()

  let nextChildId = 1

  // The first session to connect performs the real handshake; its result is
  // cached so every later session can be answered locally without re-touching
  // the single upstream connection.
  let initializeState: 'idle' | 'pending' | 'done' = 'idle'
  let cachedInitializeResult: unknown = null
  let primordialTransport: StreamableHTTPServerTransport | null = null
  // Sessions whose initialize arrived while the first handshake was still in
  // flight; resolved once that handshake's response comes back.
  const initializeWaiters: Array<{
    transport: StreamableHTTPServerTransport
    originalId: string | number
  }> = []

  const spawnChild = () => {
    logger.info(`Spawning shared child process: ${stdioCmd}`)
    child = spawn(stdioCmd, { shell: true })

    child.on('exit', (code, signal) => {
      childExited = true
      logger.error(
        `Shared child exited: code=${code}, signal=${signal}. Closing all sessions.`,
      )
      for (const [id, t] of Object.entries(transports)) {
        t.close()
        delete transports[id]
      }
      pending.clear()
      initializeWaiters.length = 0
      initializeState = 'idle'
      cachedInitializeResult = null
      primordialTransport = null
    })

    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach((line) => {
        if (!line.trim()) return
        let jsonMsg: JSONRPCMessage & { id?: string | number }
        try {
          jsonMsg = JSON.parse(line)
        } catch {
          logger.error(`Child non-JSON: ${line}`)
          return
        }
        logger.info('Child → StreamableHttp:', line)

        if (jsonMsg.id === undefined || jsonMsg.id === null) {
          // Server-initiated notification (no id): broadcast to every live session.
          for (const t of Object.values(transports)) {
            try {
              t.send(jsonMsg as JSONRPCMessage)
            } catch (e) {
              logger.error('Failed to broadcast notification to session', e)
            }
          }
          return
        }

        const entry = pending.get(String(jsonMsg.id))
        if (!entry) {
          logger.error(
            `Received response for unknown/untracked id ${jsonMsg.id}, dropping`,
          )
          return
        }
        pending.delete(String(jsonMsg.id))

        let restored = { ...jsonMsg, id: entry.originalId }

        if (entry.isInitialize && 'result' in restored && restored.result) {
          // Some upstream stdio servers don't actually validate the requested
          // protocol version — they just echo back whatever the client asked
          // for. Our own StreamableHTTPServerTransport (from the MCP SDK) DOES
          // enforce a hardcoded whitelist of versions on every request after
          // initialize. If we blindly forwarded the child's echo and the client
          // asked for a version newer than our SDK knows about, every
          // subsequent request would be rejected with a 400 "Unsupported
          // protocol version" even though initialize itself "succeeded". So we
          // negotiate against OUR OWN supported list here, instead of trusting
          // the child's echo.
          const requested = entry.requestedProtocolVersion
          const negotiated =
            requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
              ? requested
              : LATEST_PROTOCOL_VERSION
          if (
            (restored.result as { protocolVersion?: string })
              .protocolVersion !== negotiated
          ) {
            logger.info(
              `Overriding child's echoed protocolVersion "${(restored.result as { protocolVersion?: string }).protocolVersion}" (requested "${requested}") with locally-supported "${negotiated}"`,
            )
          }
          restored = {
            ...restored,
            result: { ...restored.result, protocolVersion: negotiated },
          }
        }

        try {
          entry.transport.send(restored as JSONRPCMessage)
        } catch (e) {
          logger.error('Failed to send response to session', e)
        }

        if (entry.isInitialize && 'result' in restored) {
          cachedInitializeResult = restored.result
          initializeState = 'done'
          // Resolve every session whose initialize arrived while this
          // handshake was in flight, from the same cached result.
          for (const w of initializeWaiters) {
            try {
              w.transport.send({
                jsonrpc: '2.0',
                id: w.originalId,
                result: cachedInitializeResult,
              } as JSONRPCMessage)
            } catch (e) {
              logger.error('Failed to resolve queued initialize waiter', e)
            }
          }
          initializeWaiters.length = 0
        }
      })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      logger.error(`Child stderr: ${chunk.toString('utf8')}`)
    })
  }

  spawnChild()

  onSignals({
    logger,
    cleanup: () => {
      if (!childExited) child.kill()
    },
  })

  const sendToChild = (msg: JSONRPCMessage) => {
    child.stdin.write(JSON.stringify(msg) + '\n')
  }

  // Handle POST requests for client-to-server communication
  app.post(streamableHttpPath, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport: StreamableHTTPServerTransport

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId]
      sessionCounter?.inc(sessionId, 'POST request for existing session')
    } else if (!sessionId && isInitializeRequest(req.body)) {
      const server = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          transports[sid] = transport
          sessionCounter?.inc(sid, 'session initialization')
        },
      })
      await server.connect(transport)

      transport.onmessage = (
        msg: JSONRPCMessage & { id?: string | number },
      ) => {
        logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)

        if (isInitializeRequest(msg)) {
          if (initializeState === 'idle') {
            // First session ever: perform the real handshake against the child.
            initializeState = 'pending'
            primordialTransport = transport
            const childId = `sg-${nextChildId++}`
            pending.set(childId, {
              transport,
              originalId: msg.id as string | number,
              isInitialize: true,
              requestedProtocolVersion: (
                msg as { params?: { protocolVersion?: string } }
              ).params?.protocolVersion,
            })
            sendToChild({ ...msg, id: childId } as JSONRPCMessage)
          } else if (initializeState === 'done') {
            // Later session: answer locally from the cached result, no round trip.
            transport.send({
              jsonrpc: '2.0',
              id: msg.id as string | number,
              result: cachedInitializeResult,
            } as JSONRPCMessage)
          } else {
            // A handshake is already in flight (rare race): queue this session
            // and resolve it once that handshake's response lands.
            initializeWaiters.push({
              transport,
              originalId: msg.id as string | number,
            })
          }
          return
        }

        if ('method' in msg && msg.method === 'notifications/initialized') {
          // The child only has ONE real MCP session; only the session that
          // performed the actual handshake should notify it as initialized.
          if (transport === primordialTransport) {
            sendToChild(msg)
          } else {
            logger.info(
              'Suppressing notifications/initialized from non-primordial session',
            )
          }
          return
        }

        if (msg.id === undefined || msg.id === null) {
          // Other notifications (e.g. notifications/cancelled) — forward as-is.
          sendToChild(msg)
          return
        }

        const childId = `sg-${nextChildId++}`
        pending.set(childId, {
          transport,
          originalId: msg.id as string | number,
        })
        sendToChild({ ...msg, id: childId } as JSONRPCMessage)
      }

      transport.onclose = () => {
        logger.info(`StreamableHttp connection closed (session ${sessionId})`)
        if (transport.sessionId) {
          sessionCounter?.clear(
            transport.sessionId,
            false,
            'transport being closed',
          )
          delete transports[transport.sessionId]
        }
        // Do NOT kill the shared child — other sessions may still be using it.
      }

      transport.onerror = (err) => {
        logger.error(`StreamableHttp error (session ${sessionId}):`, err)
        if (transport.sessionId) {
          sessionCounter?.clear(
            transport.sessionId,
            false,
            'transport emitting error',
          )
          delete transports[transport.sessionId]
        }
      }
    } else {
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

    await transport.handleRequest(req, res, req.body)
  })

  const handleSessionRequest = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID')
      return
    }

    sessionCounter?.inc(sessionId, `${req.method} request for existing session`)

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

  app.get(streamableHttpPath, handleSessionRequest)
  app.delete(streamableHttpPath, handleSessionRequest)

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(
      `StreamableHttp endpoint: http://localhost:${port}${streamableHttpPath}`,
    )
  })
}
