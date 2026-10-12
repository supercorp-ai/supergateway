import { ConnectionChild } from '../lib/connectionChild.js'
import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import type express from 'express'
import type {
  StartPeer,
  ChildHandoff,
  ChildOwner,
} from '../lib/childHandoff.js'
import type { Logger } from '../types.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { drained } from '../lib/outputBackpressure.js'

export type SseSessions = Record<
  string,
  {
    server: Server
    transport: SSEServerTransport
    response: express.Response
  }
>

/**
 * One SSE connection: its own `Server` and child, the client's calls the
 * child has not answered yet, and how the connection ends.
 */
export class SseSession {
  // `SSEServerTransport.sessionId` is declared `string`, not `string |
  // undefined`: the SDK assigns it in the constructor. The guard that used to
  // wrap this could not be false, so it was an obligation no test could ever
  // discharge rather than a defence against anything.
  private readonly sessionId: string
  private readonly label: string
  // The client's calls the child has not answered yet.
  private readonly pending = new Set<string | number>()
  private readonly connection: ConnectionChild

  /** Registers the session, links its child, and listens to the client. */
  constructor(
    private readonly sessions: SseSessions,
    private readonly transport: SSEServerTransport,
    server: Server,
    req: express.Request,
    private readonly res: express.Response,
    peer: StartPeer,
    handoff: ChildHandoff,
    private readonly logger: Logger,
  ) {
    const sessionId = (this.sessionId = transport.sessionId)
    this.label = `Session ${sessionId}`
    sessions[sessionId] = { server, transport, response: res }
    this.connection = new ConnectionChild(
      peer,
      this.owner(),
      handoff,
      logger,
      this.label,
    )

    transport.onmessage = (msg: JSONRPCMessage, extra) => {
      if ('id' in msg && 'method' in msg) this.pending.add(msg.id!)
      logger.info(`SSE → Child (session ${sessionId}): ${JSON.stringify(msg)}`)
      // The SDK's handlePostMessage passes `requestInfo` with every message;
      // only `extra` itself is optional in its type.
      const version = extra?.requestInfo!.headers['mcp-protocol-version']
      this.connection.fromClient(
        msg,
        typeof version === 'string' ? version : undefined,
      )
    }

    transport.onclose = () =>
      this.end(
        () => logger.info(`SSE connection closed (session ${sessionId})`),
        true,
      )

    // The SDK also calls `onerror` for a single rejected POST (bad content
    // type, oversized body, invalid JSON-RPC). The SSE stream is still alive;
    // `onclose` and the client socket close handle actual session teardown.
    transport.onerror = (err) =>
      logger.error(`SSE error (session ${sessionId}):`, err)

    req.on('close', () =>
      this.end(
        () => logger.info(`Client disconnected (session ${sessionId})`),
        true,
      ),
    )
  }

  // Closing the session's own `Server` is what releases its transport. Without
  // it the object stays connected and the next `connect` on it would throw
  // again — the same failure one indirection further along.
  //
  // The order matters. `server.close()` closes its transport, and closing an
  // `SSEServerTransport` fires `onclose`, which arrives back here. Removing
  // the session *before* closing is what stops that round trip becoming
  // unbounded recursion — the hazard @RussellZager identified on #113 — and
  // it is also why the ending that started it is the only one logged.
  //
  // Only a client leaving can hand its child on; a session that ends because
  // its child failed stops it.
  private end(report: () => void, clientLeft = false) {
    const { sessions, sessionId } = this
    if (!sessions[sessionId]) return
    report()
    const { server } = sessions[sessionId]
    delete sessions[sessionId]
    this.connection.end(clientLeft)
    server.close().catch((err) => {
      this.logger.error(`Failed to close session ${sessionId}:`, err)
    })
  }

  // A child that fails with calls in flight used to end the session
  // silently, and the SSE client waited out its own timeout on each one (60
  // seconds by default). Answer them first, as stateful HTTP does, then end.
  private fail() {
    // `send` writes to the stream before it returns, so the replies are
    // queued ahead of the close. One that cannot be sent is a stream already
    // gone; the session ends regardless, and at once, so no new message is
    // accepted for a server that is not there.
    void Promise.allSettled(
      [...this.pending].map((id) =>
        this.transport.send({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: 'MCP server process failed' },
        }),
      ),
    )
    this.pending.clear()
    this.end(() => {})
  }

  private owner(): ChildOwner {
    const { logger, sessionId, sessions } = this
    return {
      message: (jsonMsg) => {
        if ('id' in jsonMsg && !('method' in jsonMsg))
          this.pending.delete(jsonMsg.id)
        logger.info(`Child → SSE (session ${sessionId}):`, jsonMsg)
        if (!sessions[sessionId]) return
        this.transport.send(jsonMsg).catch((err) => {
          this.end(() =>
            logger.error(`Failed to send to session ${sessionId}:`, err),
          )
        })
      },
      nonJson: (line) =>
        logger.error(`Child non-JSON (session ${sessionId}): ${line}`),
      stderr: (text) =>
        logger.error(`Child stderr (session ${sessionId}): ${text}`),
      failure: (kind, err) => {
        logger.error(
          `${kind === 'stdin' ? 'Child stdin failure' : 'Child failure'} (session ${sessionId}):`,
          err,
        )
        this.fail()
      },
      exit: (code, signal) => {
        const detail = `Child exited (session ${sessionId}): code=${code}, signal=${signal}`
        if (!sessions[sessionId]) {
          logger.info(detail)
          return
        }
        logger.error(detail)
        this.fail()
      },
      output: () => drained([this.res]),
    }
  }
}
