import { ChildLink, type StartPeer } from '../lib/childHandoff.js'
import type { StatefulSessions } from './statefulSessions.js'
import type express from 'express'
import type { Logger } from '../types.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { getVersion } from '../lib/getVersion.js'
import { randomUUID } from 'node:crypto'
import { SessionLivenessProbe } from '../lib/sessionLivenessProbe.js'
import { drained } from '../lib/outputBackpressure.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { failPendingCalls } from '../lib/failPendingCalls.js'

/**
 * One session: its SDK server and transport, its child, the calls the child
 * has not answered yet, and how the session ends when the child does.
 */
export class StatefulSession {
  private initializedSessionId: string | undefined
  private readonly pendingRequests = new Set<string | number>()
  // The request each progress token came with, while it is pending.
  private readonly progressOf = new Map<string | number, string | number>()
  private readonly link: ChildLink
  private childStopped = false
  private childFailed = false

  /**
   * Connects a new session's transport to its own SDK server, then starts its
   * child with `begin`, which is given the transport and the session's open
   * responses to register first.
   */
  static async open(
    sessions: StatefulSessions,
    res: express.Response,
    logger: Logger,
    sessionTimeout: number | null,
    begin: (
      transport: StreamableHTTPServerTransport,
      responses: Set<express.Response>,
    ) => StartPeer,
  ): Promise<StatefulSession> {
    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )
    // Assigned below, before the SDK or the probe can call back.
    let session!: StatefulSession
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => session.initialized(sessionId),
    })
    // Bound probe traffic without adding a new option. sessionTimeout is
    // still the minimum inactivity period before a session can be reaped.
    const probe = sessionTimeout
      ? new SessionLivenessProbe(
          Math.max(5_000, Math.min(sessionTimeout, 300_000)),
          Math.max(5_000, Math.min(sessionTimeout, 30_000)),
          sessionTimeout,
          async (id) => {
            await transport.send({ jsonrpc: '2.0', id, method: 'ping' })
          },
          () => {
            transport.close().catch((error) => {
              logger.error('Failed to close stale session:', error)
              session.stopChild('stale transport close failed')
            })
          },
          logger,
        )
      : undefined
    await server.connect(transport)
    const responses = new Set<express.Response>()
    const peer = begin(transport, responses)
    session = new StatefulSession(
      sessions,
      res,
      logger,
      transport,
      probe,
      responses,
      peer,
    )
    return session
  }

  /** Links the session to its server, and the client's messages to both. */
  private constructor(
    private readonly sessions: StatefulSessions,
    private readonly res: express.Response,
    private readonly logger: Logger,
    readonly transport: StreamableHTTPServerTransport,
    private readonly probe: SessionLivenessProbe | undefined,
    private readonly responses: Set<express.Response>,
    peer: StartPeer,
  ) {
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

  private initialized(sessionId: string) {
    this.initializedSessionId = sessionId
    this.sessions.register(sessionId, this.transport, this.probe)
  }

  private fromChild(jsonMsg: any, line: string) {
    this.logger.info('Child → StreamableHttp:', line)
    if ('id' in jsonMsg && !('method' in jsonMsg)) this.settle(jsonMsg.id)
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
        relatedRequestId: this.relatedRequest(jsonMsg),
      })
      .catch((e) => {
        this.logger.error(`Failed to send to StreamableHttp`, e)
      })
  }

  // The request in flight a message from the child rides with. Progress is
  // its own request's: with several calls in flight, the first one's stream
  // may close, on its answer, while another's progress is still arriving.
  // Anything else rides the first, which has always been enough to deliver
  // it.
  private relatedRequest(message: {
    method?: string
    params?: { progressToken?: string | number }
  }) {
    const own =
      message.method === 'notifications/progress'
        ? this.progressOf.get(message.params?.progressToken as string)
        : undefined
    // A token is forgotten with its request, so `own` is in flight.
    return own ?? this.pendingRequests.values().next().value
  }

  // A request is answered or cancelled: nothing rides with it any more.
  private settle(requestId: string | number): boolean {
    for (const [token, id] of this.progressOf)
      if (id === requestId) this.progressOf.delete(token)
    return this.pendingRequests.delete(requestId)
  }

  private fromClient(msg: JSONRPCMessage) {
    if (this.probe?.accept(msg)) return
    if ('id' in msg && 'method' in msg) {
      this.pendingRequests.add(msg.id)
      const token = (
        msg.params as
          { _meta?: { progressToken?: string | number } } | undefined
      )?._meta?.progressToken
      if (token !== undefined) this.progressOf.set(token, msg.id)
    }
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
    if (!this.settle(requestId!)) return
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
