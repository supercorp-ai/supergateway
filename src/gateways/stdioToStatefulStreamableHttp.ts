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
import { randomUUID } from 'node:crypto'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'
import { SessionLivenessProbe } from '../lib/sessionLivenessProbe.js'
import { endpointHost, listenOn } from '../lib/listenHost.js'
import type { Mount } from '../lib/serve.js'
import { streamableHttpApp } from '../lib/streamableHttpApp.js'
import { announceGateway } from '../lib/gatewayListing.js'
import { onSignals } from '../lib/onSignals.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { drained } from '../lib/outputBackpressure.js'
import { ChildLink, type StartPeer } from '../lib/childHandoff.js'
import { failPendingCalls } from '../lib/failPendingCalls.js'
import { startServer, type ServerSource } from '../lib/serverSource.js'

interface StdioToStreamableHttpOptions {
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

/** A server and how it is served over Streamable HTTP. */
export type StdioToStreamableHttpArgs = ServerSource &
  StdioToStreamableHttpOptions

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
  args: ServerSource &
    Omit<StdioToStreamableHttpOptions, 'port'> & {
      port?: number
      /** The URL path the server's requests start with; `/` by default. */
      path?: string
    },
): Mount {
  const {
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

  announceGateway(logger, {
    headers,
    port,
    host,
    source: args,
    settings: [`streamableHttpPath: ${streamableHttpPath}`],
    corsOrigin,
    healthEndpoints,
    apiKeys,
  })
  logger.info(
    `  - Session timeout: ${sessionTimeout ? `${sessionTimeout}ms` : 'disabled'}`,
  )

  const children = new OwnedChildProcesses(logger)
  // The 2026-07-28 relay starts a local server per request. A remote one is
  // served over the sessions of the earlier protocol versions only.
  const modern = args.upstream
    ? undefined
    : createModernHttp({ stdioCmd: args.stdioCmd, children, logger })

  const app = streamableHttpApp(express, cors, {
    headers,
    corsOrigin,
    exposedHeaders: ['Mcp-Session-Id'],
    healthEndpoints,
    apiKeys,
    logger,
  })

  const sessions = new StatefulSessions(args, children, logger, sessionTimeout)

  // Handle POST requests for client-to-server communication
  app.post(streamableHttpPath, async (req, res) => {
    if (children.closing) {
      res.status(503).send('Gateway is shutting down')
      return
    }
    if (await modern?.handle(req, res)) return
    await sessions.post(req, res)
  })

  // Handle GET requests for server-to-client notifications via SSE
  app.get(streamableHttpPath, (req, res) => sessions.request(req, res))

  // Handle DELETE requests for session termination
  app.delete(streamableHttpPath, (req, res) => sessions.request(req, res))

  return {
    app,
    path,
    listening: (listenHost, listenPort) =>
      logger.info(
        `StreamableHttp endpoint: http://${endpointHost(listenHost)}:${listenPort}${streamableHttpPath}`,
      ),
    close: async () => {
      await Promise.all([modern?.close(), children.close()])
    },
  }
}

/**
 * A stateful gateway's sessions: each one's transport, child and, with
 * --sessionTimeout, liveness probe, found by the id the SDK gave it.
 */
class StatefulSessions {
  // A real Map, not an object. A plain object's keys are looked up through
  // `Object.prototype`, so an unissued session id like `toString` or
  // `constructor` resolves to an inherited function and is then used as a
  // transport — every name on that prototype crashed the gateway, from an
  // ordinary HTTP header, before any session existed. A Map has no such
  // inheritance, which fixes the class rather than the names.
  private readonly transports = new Map<string, StreamableHTTPServerTransport>()
  private readonly liveness = new Map<string, SessionLivenessProbe>()
  // Each session's open responses (its POSTs and its GET stream), so its child
  // is held while any of them is backed up.
  private readonly openResponses = new WeakMap<
    StreamableHTTPServerTransport,
    Set<express.Response>
  >()
  // Session access counter for timeout management
  private readonly counter: SessionAccessCounter | null

  constructor(
    private readonly source: ServerSource,
    private readonly children: OwnedChildProcesses,
    private readonly logger: Logger,
    private readonly sessionTimeout: number | null,
  ) {
    this.counter = sessionTimeout
      ? new SessionAccessCounter(
          sessionTimeout,
          (sessionId: string) => this.timedOut(sessionId),
          logger,
        )
      : null
  }

  private timedOut(sessionId: string) {
    this.logger.info(`Session ${sessionId} timed out, cleaning up`)
    // Reached only from the idle timer, and every path that removes a
    // transport cancels that timer first: both `clear()` call sites pass
    // `runCleanup: false`, so this callback never runs for a session that
    // has already gone. The presence check could not be false.
    //
    // Still async, and still running from a timer with nothing above it,
    // so the rejection handler stays — a cleanup path is the worst place
    // to crash.
    const transport = this.transports.get(sessionId)!
    transport.close().catch((err) => {
      this.logger.error(`Failed to close timed-out session ${sessionId}`, err)
    })
    this.transports.delete(sessionId)
  }

  /** A session the SDK has just given its id. */
  register(
    sessionId: string,
    transport: StreamableHTTPServerTransport,
    probe: SessionLivenessProbe | undefined,
  ) {
    if (probe) this.liveness.set(sessionId, probe)
    // Store the transport by session ID
    this.transports.set(sessionId, transport)
    // Initialize session access count
    this.counter?.inc(sessionId, 'session initialization')
  }

  /** A session whose child has stopped, for `reason`. */
  forget(sessionId: string, reason: string) {
    this.liveness.delete(sessionId)
    this.counter?.clear(sessionId, false, reason)
    this.transports.delete(sessionId)
  }

  private watch(
    transport: StreamableHTTPServerTransport,
    res: express.Response,
  ) {
    const responses = this.openResponses.get(transport)!
    responses.add(res)
    res.once('close', () => responses.delete(res))
  }

  // A new session: its server, transport, child and, with --sessionTimeout,
  // liveness probe. The transport is registered once the SDK assigns the
  // session its id.
  private async open(
    res: express.Response,
  ): Promise<StreamableHTTPServerTransport> {
    const session = new StatefulSession(
      this,
      res,
      this.logger,
      this.sessionTimeout,
    )
    await session.server.connect(session.transport)
    this.openResponses.set(session.transport, session.responses)
    session.start(
      startServer(spawn, this.source, this.children, this.logger, 'Session'),
    )
    return session.transport
  }

  /** A POST: to a session we hold, or an initialize request opening one. */
  async post(req: express.Request, res: express.Response) {
    // Check for existing session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    let transport: StreamableHTTPServerTransport

    if (sessionId && this.transports.has(sessionId)) {
      // Reuse existing transport
      transport = this.transports.get(sessionId)!
      this.liveness.get(sessionId)?.requestStarted()
      // Increment session access count
      this.counter?.inc(sessionId, 'POST request for existing session')
    } else if (!sessionId && isInitializeRequest(req.body)) {
      transport = await this.open(res)
    } else {
      rejectSession(res, sessionId)
      return
    }

    // Decrement session access count when response ends
    let responseEnded = false
    const handleResponseEnd = (event: string) => {
      if (!responseEnded && transport.sessionId) {
        responseEnded = true
        this.logger.info(`Response ${event}`, transport.sessionId)
        this.counter?.dec(transport.sessionId, `POST response ${event}`)
        this.liveness.get(transport.sessionId)?.requestFinished()
      }
    }

    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))
    this.watch(transport, res)

    // Handle the request
    await transport.handleRequest(req, res, req.body)
  }

  /** A GET (the session's stream) or a DELETE (its end). */
  async request(req: express.Request, res: express.Response) {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId) {
      res.status(400).send('Invalid or missing session ID')
      return
    }
    if (!this.transports.has(sessionId)) {
      // Unknown session id -> 404 so the client re-initializes instead of
      // retrying a dead id. See rejectSession for the spec citation.
      res.status(404).send('Session not found')
      return
    }

    // Increment session access count
    this.counter?.inc(sessionId, `${req.method} request for existing session`)

    if (req.method === 'GET') {
      const probe = this.liveness.get(sessionId)
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
        this.logger.info(`Response ${event}`, sessionId)
        this.counter?.dec(sessionId, `${req.method} response ${event}`)
      }
    }

    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))

    const transport = this.transports.get(sessionId)!
    this.watch(transport, res)
    await transport.handleRequest(req, res)
  }
}

/**
 * One session: its SDK server and transport, its child, the calls the child
 * has not answered yet, and how the session ends when the child does.
 */
class StatefulSession {
  readonly server = new Server(
    { name: 'supergateway', version: getVersion() },
    { capabilities: {} },
  )
  readonly transport: StreamableHTTPServerTransport
  readonly probe: SessionLivenessProbe | undefined
  readonly responses = new Set<express.Response>()
  private initializedSessionId: string | undefined
  private readonly pendingRequests = new Set<string | number>()
  private link!: ChildLink
  private childStopped = false
  private childFailed = false

  constructor(
    private readonly sessions: StatefulSessions,
    private readonly res: express.Response,
    private readonly logger: Logger,
    sessionTimeout: number | null,
  ) {
    this.transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        this.initializedSessionId = sessionId
        sessions.register(sessionId, this.transport, this.probe)
      },
    })
    // Bound probe traffic without adding a new option. sessionTimeout is
    // still the minimum inactivity period before a session can be reaped.
    this.probe = sessionTimeout
      ? new SessionLivenessProbe(
          Math.max(5_000, Math.min(sessionTimeout, 300_000)),
          Math.max(5_000, Math.min(sessionTimeout, 30_000)),
          sessionTimeout,
          async (id) => {
            await this.transport.send({ jsonrpc: '2.0', id, method: 'ping' })
          },
          () => {
            this.transport.close().catch((error) => {
              logger.error('Failed to close stale session:', error)
              this.stopChild('stale transport close failed')
            })
          },
          logger,
        )
      : undefined
  }

  /** Links the session to its server, and the client's messages to both. */
  start(peer: StartPeer) {
    const { logger, transport } = this
    this.link = new ChildLink(peer, {
      failure: (_kind, err) => this.fail(err),
      exit: (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        // HTTP EOF alone does not settle an SDK request. Use the same
        // idempotent error delivery as spawn/stdin failure before closing.
        this.fail()
      },
      message: (jsonMsg, line) => this.fromChild(jsonMsg, line),
      nonJson: (line) => logger.error(`Child non-JSON: ${line}`),
      stderr: (text) => logger.error(`Child stderr: ${text}`),
      output: () => drained(this.responses),
    })

    transport.onmessage = (msg: JSONRPCMessage) => this.fromClient(msg)

    transport.onclose = () => {
      logger.info(
        `StreamableHttp connection closed (session ${this.initializedSessionId ?? '(uninitialized)'})`,
      )
      this.stopChild('transport being closed')
    }

    transport.onerror = (err) => {
      logger.error(
        `StreamableHttp error (session ${this.initializedSessionId ?? '(uninitialized)'}):`,
        err,
      )
      // A rejected HTTP request is recoverable; actual transport closure
      // and child failure have their own cleanup paths.
    }
  }

  private fromChild(jsonMsg: any, line: string) {
    this.logger.info('Child → StreamableHttp:', line)
    if ('id' in jsonMsg && !('method' in jsonMsg)) {
      this.pendingRequests.delete(jsonMsg.id)
    }
    this.transport
      .send(jsonMsg, {
        // A message with no related request is routed to the standalone
        // GET stream, and the SDK returns silently when that stream is
        // not connected yet — so nothing throws and the notification is
        // simply gone. That window is exactly the start of a call, which
        // is where a tool emits its first progress notification: soak run
        // 35410255256 lost `progress: 1` and kept 2 and 3. Responses
        // route by their own id regardless; everything else rides the
        // request in flight, as the stateless bridge already does.
        relatedRequestId: this.pendingRequests.values().next().value,
      })
      .catch((e) => {
        this.logger.error(`Failed to send to StreamableHttp`, e)
      })
  }

  private fromClient(msg: JSONRPCMessage) {
    if (this.probe?.accept(msg)) return
    if ('id' in msg && 'method' in msg) this.pendingRequests.add(msg.id!)
    this.logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)
    this.link.write(msg)
    if ('method' in msg && msg.method === 'notifications/cancelled')
      this.endCancelled(
        (msg.params as { requestId?: string | number } | undefined)?.requestId,
      )
  }

  // A server sends nothing for a cancelled call, and the response stream
  // for it stays open until the call is answered: every cancel in a
  // long-lived session held a socket until the session ended (measured: 30
  // cancels, 30 more descriptors). Close that stream, and stop routing
  // notifications to it. The SDK has closeSSEStream from 1.23.1; with an
  // older one the stream stays open, as before.
  private endCancelled(requestId: string | number | undefined) {
    if (!this.pendingRequests.delete(requestId!)) return
    // Typed by hand: the SDK matrix builds against versions that do not
    // declare it.
    const closable = this.transport as unknown as {
      closeSSEStream?: (requestId: string | number) => void
    }
    if (typeof closable.closeSSEStream === 'function')
      closable.closeSSEStream(requestId!)
  }

  private stopChild(reason: string) {
    if (this.childStopped) return
    this.childStopped = true
    if (this.initializedSessionId)
      this.sessions.forget(this.initializedSessionId, reason)
    this.probe?.close()
    void this.link.stop()
  }

  // Exit, ChildProcess errors and stdin errors can arrive for the same
  // child. Keep listeners installed and terminate this transport once.
  private fail(err?: Error) {
    if (this.childFailed) return
    this.childFailed = true
    if (err) this.logger.error('Child process failure:', err)
    this.stopChild('child process failure')
    failPendingCalls({
      transport: this.transport,
      pending: this.pendingRequests,
      res: this.res,
      logger: this.logger,
    })
  }
}

// A request that names no session we hold, or names none and is not an
// initialize request.
function rejectSession(res: express.Response, sessionId: string | undefined) {
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
