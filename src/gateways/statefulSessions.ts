import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { SessionLivenessProbe } from '../lib/sessionLivenessProbe.js'
import type express from 'express'
import { SessionAccessCounter } from '../lib/sessionAccessCounter.js'
import { type ServerSource, startServer } from '../lib/serverSource.js'
import type { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import type { Logger } from '../types.js'
import { StatefulSession } from './statefulSession.js'
import { spawn } from 'child_process'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

/**
 * A stateful gateway's sessions: each one's transport, child and, with
 * --sessionTimeout, liveness probe, found by the id the SDK gave it.
 */
export class StatefulSessions {
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

  // Decrement session access count when the response ends, once, whichever
  // of finish and close comes first. A POST's session may have no id yet: an
  // initialize the SDK rejected never gets one.
  private countResponse(
    res: express.Response,
    method: string,
    sessionId: () => string | undefined,
    ended?: (sessionId: string) => void,
  ) {
    let responseEnded = false
    const handleResponseEnd = (event: string) => {
      const id = sessionId()
      if (responseEnded || !id) return
      responseEnded = true
      this.logger.info(`Response ${event}`, id)
      // A session forgotten while this response was open, because its server
      // failed or it expired, has no count left to lower.
      if (this.transports.has(id))
        this.counter?.dec(id, `${method} response ${event}`)
      ended?.(id)
    }
    res.on('finish', () => handleResponseEnd('finished'))
    res.on('close', () => handleResponseEnd('closed'))
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
    const session = await StatefulSession.open(
      this,
      res,
      this.logger,
      this.sessionTimeout,
      (transport, responses) => {
        this.openResponses.set(transport, responses)
        return startServer(
          spawn,
          this.source,
          this.children,
          this.logger,
          'Session',
        )
      },
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

    this.countResponse(
      res,
      'POST',
      () => transport.sessionId,
      (id) => this.liveness.get(id)?.requestFinished(),
    )
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

    this.countResponse(res, req.method, () => sessionId)

    const transport = this.transports.get(sessionId)!
    this.watch(transport, res)
    await transport.handleRequest(req, res)
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
