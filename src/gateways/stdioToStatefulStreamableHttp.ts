import { spawn } from 'child_process'
import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { createModernHttp } from '../lib/modernHttp.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { randomUUID } from 'node:crypto'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'
import { SessionLivenessProbe } from '../lib/sessionLivenessProbe.js'
import { escapeSseJsonSeparators } from '../lib/escapeSseJsonSeparators.js'
import { jsonBodyErrors } from '../lib/jsonBodyErrors.js'
import { describeHeaders } from '../lib/headers.js'
import { announceHost, endpointHost, listenOn } from '../lib/listenHost.js'
import type { Mount } from '../lib/serve.js'
import { onSignals } from '../lib/onSignals.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { drained } from '../lib/outputBackpressure.js'
import { ChildLink, processPeer } from '../lib/childHandoff.js'
import { failPendingCalls } from '../lib/failPendingCalls.js'
import { logApiKeys, requireApiKey } from '../lib/apiKey.js'
import {
  describeCommand,
  spawnCommand,
  type ChildCommand,
} from '../lib/childCommand.js'

export interface StdioToStreamableHttpArgs {
  stdioCmd: ChildCommand
  port: number
  /** The address to listen on; every interface when unset. */
  host?: string
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  // The keys a client must present; none, or left out, means no check.
  apiKeys?: string[]
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
  const { port, host, logger } = args
  const mount = stdioToStatefulStreamableHttpMount(args)
  onSignals({ logger, cleanup: mount.close, drainStdin: true })
  keepConnectionsAlive(
    listenOn(mount.app, port, host, () => {
      logger.info(`Listening on port ${port}`)
      mount.listening(host, port)
    }),
  )
}

export function stdioToStatefulStreamableHttpMount(
  args: Omit<StdioToStreamableHttpArgs, 'port'> & {
    port?: number
    /** The URL path the server's requests start with; `/` by default. */
    path?: string
  },
): Mount {
  const {
    stdioCmd,
    port,
    host,
    streamableHttpPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    apiKeys = [],
    path = '/',
    sessionTimeout,
  } = args

  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  if (port !== undefined) {
    logger.info(`  - port: ${port}`)
    announceHost(logger, host)
  }
  logger.info(`  - stdio: ${describeCommand(stdioCmd)}`)
  logger.info(`  - streamableHttpPath: ${streamableHttpPath}`)

  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )
  logApiKeys(logger, apiKeys)
  logger.info(
    `  - Session timeout: ${sessionTimeout ? `${sessionTimeout}ms` : 'disabled'}`,
  )

  const children = new OwnedChildProcesses(logger)
  const modern = createModernHttp({ stdioCmd, children, logger })

  const app = express()
  app.use((_req, res, next) => {
    escapeSseJsonSeparators(res)
    // --header applies to every response, as it does in SSE mode. It used to
    // reach only the health endpoint.
    setResponseHeaders({ res, headers })
    next()
  })
  // Same ceiling the SDK applies to SSE messages; express defaults to 100 kB.
  const parseJson = [express.json({ limit: '4mb' }), jsonBodyErrors]
  // Without keys, bodies are read here, as they always were. With keys, not
  // until the request has presented one: an unauthenticated caller must not
  // make the gateway read and parse up to 4 MB, and gets 401, not 400 or 413.
  if (apiKeys.length === 0) app.use(parseJson)

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
      res.send('ok')
    })
  }

  // After CORS and the health endpoints, which stay open; before POST, GET
  // and DELETE on the path, modern 2026-07-28 requests included.
  app.use(requireApiKey(apiKeys, logger))
  if (apiKeys.length > 0) app.use(parseJson)

  // A real Map, not an object. A plain object's keys are looked up through
  // `Object.prototype`, so an unissued session id like `toString` or
  // `constructor` resolves to an inherited function and is then used as a
  // transport — every name on that prototype crashed the gateway, from an
  // ordinary HTTP header, before any session existed. A Map has no such
  // inheritance, which fixes the class rather than the names.
  const transports = new Map<string, StreamableHTTPServerTransport>()
  const liveness = new Map<string, SessionLivenessProbe>()
  // Each session's open responses (its POSTs and its GET stream), so its child
  // is held while any of them is backed up.
  const openResponses = new WeakMap<
    StreamableHTTPServerTransport,
    Set<express.Response>
  >()
  const watch = (
    transport: StreamableHTTPServerTransport,
    res: express.Response,
  ) => {
    const responses = openResponses.get(transport)!
    responses.add(res)
    res.once('close', () => responses.delete(res))
  }

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
  // A new session: its server, transport, child and, with --sessionTimeout,
  // liveness probe. The transport is registered once the SDK assigns the
  // session its id.
  const openSession = async (
    res: express.Response,
  ): Promise<StreamableHTTPServerTransport> => {
    // New initialization request
    let initializedSessionId: string | undefined
    let probe: SessionLivenessProbe | undefined

    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )

    const transport: StreamableHTTPServerTransport =
      new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          initializedSessionId = sessionId
          if (probe) liveness.set(sessionId, probe)
          // Store the transport by session ID
          transports.set(sessionId, transport)
          // Initialize session access count
          sessionCounter?.inc(sessionId, 'session initialization')
        },
      })
    if (sessionTimeout) {
      // Bound probe traffic without adding a new option. sessionTimeout is
      // still the minimum inactivity period before a session can be reaped.
      probe = new SessionLivenessProbe(
        Math.max(5_000, Math.min(sessionTimeout, 300_000)),
        Math.max(5_000, Math.min(sessionTimeout, 30_000)),
        sessionTimeout,
        async (id) => {
          await transport.send({ jsonrpc: '2.0', id, method: 'ping' })
        },
        () => {
          transport.close().catch((error) => {
            logger.error('Failed to close stale session:', error)
            stopChild('stale transport close failed')
          })
        },
        logger,
      )
    }
    await server.connect(transport)
    const responses = new Set<express.Response>()
    openResponses.set(transport, responses)
    const child = spawnCommand(spawn, stdioCmd, children.spawnOptions)
    const stop = children.own(child)
    const pendingRequests = new Set<string | number>()
    let childStopped = false
    const stopChild = (reason: string) => {
      if (childStopped) return
      childStopped = true
      if (initializedSessionId) {
        liveness.delete(initializedSessionId)
        sessionCounter?.clear(initializedSessionId, false, reason)
        transports.delete(initializedSessionId)
      }
      probe?.close()
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
      failPendingCalls({ transport, pending: pendingRequests, res, logger })
    }
    const link = new ChildLink(processPeer(child, stop), {
      failure: (_kind, err) => handleChildFailure(err),
      exit: (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        // HTTP EOF alone does not settle an SDK request. Use the same
        // idempotent error delivery as spawn/stdin failure before closing.
        handleChildFailure()
      },
      message: (jsonMsg, line) => {
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
      },
      nonJson: (line) => logger.error(`Child non-JSON: ${line}`),
      stderr: (text) => logger.error(`Child stderr: ${text}`),
      output: () => drained(responses),
    })

    transport.onmessage = (msg: JSONRPCMessage) => {
      if (probe?.accept(msg)) return
      if ('id' in msg && 'method' in msg) pendingRequests.add(msg.id!)
      logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)
      link.write(msg)
      if ('method' in msg && msg.method === 'notifications/cancelled')
        endCancelled(
          (msg.params as { requestId?: string | number } | undefined)
            ?.requestId,
        )
    }

    // A server sends nothing for a cancelled call, and the response stream
    // for it stays open until the call is answered: every cancel in a
    // long-lived session held a socket until the session ended (measured: 30
    // cancels, 30 more descriptors). Close that stream, and stop routing
    // notifications to it. The SDK has closeSSEStream from 1.23.1; with an
    // older one the stream stays open, as before.
    const endCancelled = (requestId: string | number | undefined) => {
      if (!pendingRequests.delete(requestId!)) return
      // Typed by hand: the SDK matrix builds against versions that do not
      // declare it.
      const closable = transport as unknown as {
        closeSSEStream?: (requestId: string | number) => void
      }
      if (typeof closable.closeSSEStream === 'function')
        closable.closeSSEStream(requestId!)
    }

    transport.onclose = () => {
      logger.info(
        `StreamableHttp connection closed (session ${initializedSessionId ?? '(uninitialized)'})`,
      )
      stopChild('transport being closed')
    }

    transport.onerror = (err) => {
      logger.error(
        `StreamableHttp error (session ${initializedSessionId ?? '(uninitialized)'}):`,
        err,
      )
      // A rejected HTTP request is recoverable; actual transport closure
      // and child failure have their own cleanup paths.
    }
    return transport
  }

  // A request that names no session we hold, or names none and is not an
  // initialize request.
  const rejectSession = (
    res: express.Response,
    sessionId: string | undefined,
  ) => {
    if (sessionId) {
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
    }
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
  }

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
      liveness.get(sessionId)?.requestStarted()
      // Increment session access count
      sessionCounter?.inc(sessionId, 'POST request for existing session')
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = await openSession(res)
    } else {
      rejectSession(res, sessionId)
      return
    }

    // Decrement session access count when response ends
    let responseEnded = false
    const handleResponseEnd = (event: string) => {
      if (!responseEnded && transport.sessionId) {
        responseEnded = true
        logger.info(`Response ${event}`, transport.sessionId)
        sessionCounter?.dec(transport.sessionId, `POST response ${event}`)
        liveness.get(transport.sessionId)?.requestFinished()
      }
    }

    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))
    watch(transport, res)

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

    if (req.method === 'GET') {
      const probe = liveness.get(sessionId)
      if (probe?.start()) {
        res.once('finish', () => probe.stop())
        res.once('close', () => probe.stop())
      }
    }

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
    watch(transport, res)
    await transport.handleRequest(req, res)
  }

  // Handle GET requests for server-to-client notifications via SSE
  app.get(streamableHttpPath, handleSessionRequest)

  // Handle DELETE requests for session termination
  app.delete(streamableHttpPath, handleSessionRequest)

  return {
    app,
    path,
    listening: (listenHost, listenPort) =>
      logger.info(
        `StreamableHttp endpoint: http://${endpointHost(listenHost)}:${listenPort}${streamableHttpPath}`,
      ),
    close: async () => {
      await Promise.all([modern.close(), children.close()])
    },
  }
}
