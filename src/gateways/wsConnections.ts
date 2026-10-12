import { ConnectionChild } from '../lib/connectionChild.js'
import type { WebSocketServerTransport } from '../server/websocket.js'
import { type ServerSource, startServer } from '../lib/serverSource.js'
import type { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import type {
  ChildHandoff,
  StartPeer,
  ChildOwner,
} from '../lib/childHandoff.js'
import type { Logger } from '../types.js'
import { spawn } from 'child_process'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * The WebSocket clients and their children. Each connection has its own child,
 * as each SSE connection does since #221. With one child shared by every
 * client, notifications and the server's own requests could only be
 * broadcast: one client received another's logs and progress, and could be
 * asked to answer its sampling.
 */
export class WsConnections {
  private readonly connections = new Map<string, ConnectionChild>()
  // Assigned as soon as the transport exists: it is built with this object's
  // handlers, and calls none of them before it starts.
  transport!: WebSocketServerTransport

  constructor(
    private readonly source: ServerSource,
    private readonly children: OwnedChildProcesses,
    private readonly handoff: ChildHandoff,
    private readonly logger: Logger,
  ) {}

  /**
   * A new connection's own child, spawned and recorded under its client; or,
   * when the spawn throws, the client disconnected instead.
   */
  open(clientId: string) {
    this.logger.info(`New WebSocket connection: ${clientId}`)
    let server: StartPeer
    try {
      server = startServer(
        spawn,
        this.source,
        this.children,
        this.logger,
        `Client ${clientId}`,
      )
    } catch (err) {
      // Thrown inside the socket's connection event it would take down the
      // gateway and every other client with it.
      this.logger.error(
        `Failed to start the MCP server (client ${clientId}):`,
        err,
      )
      this.transport.disconnect(clientId, 'MCP server process failed')
      return
    }
    // A client that reconnects and carries on without initializing gets its
    // new child initialized by the gateway (GW-034).
    const connection = new ConnectionChild(
      server,
      this.owner(clientId),
      this.handoff,
      this.logger,
      `Client ${clientId}`,
    )
    this.connections.set(clientId, connection)
  }

  /** Where a connection's child delivers what it says, and how it ends. */
  private owner(clientId: string): ChildOwner {
    const logger = this.logger
    // What this connection has sent the client since its stdout was last
    // read, for the child to wait on.
    let sent: Promise<void> | undefined
    return {
      message: (message, line) => {
        logger.info(`Child → WebSocket (client ${clientId}): ${line}`)
        sent = this.transport.send(message, clientId)
      },
      nonJson: (line) =>
        logger.error(`Child non-JSON (client ${clientId}): ${line}`),
      stderr: (text) =>
        logger.info(`Child stderr (client ${clientId}): ${text}`),
      failure: (kind, err) => {
        logger.error(
          `${kind === 'stdin' ? 'Child stdin failure' : 'Child failure'} (client ${clientId}):`,
          err,
        )
        this.end(clientId, 'MCP server process failed')
      },
      exit: (code, signal) => {
        logger.info(
          `Child exited (client ${clientId}): code=${code}, signal=${signal}`,
        )
        this.end(clientId, 'MCP server process exited')
      },
      output: () => {
        const pending = sent
        sent = undefined
        return pending
      },
    }
  }

  /** A message from a client, for its child. */
  fromClient(message: JSONRPCMessage, clientId: string) {
    const line = JSON.stringify(message)
    const connection = this.connections.get(clientId)
    // A frame can still arrive after the child ended, while the socket `end`
    // closed is finishing its close handshake.
    if (!connection) {
      this.logger.info(`Dropped a message for ended client ${clientId}`)
      return
    }
    this.logger.info(`WebSocket → Child (client ${clientId}): ${line}`)
    connection.fromClient(message)
  }

  /**
   * A connection's child is stopped once, whichever ending comes first: the
   * client leaving, the child exiting, or its stdio failing. Only the client
   * leaving can hand the child on instead.
   */
  end(clientId: string, reason: string, clientLeft = false) {
    const connection = this.connections.get(clientId)
    if (!connection) return
    this.connections.delete(clientId)
    connection.end(clientLeft)
    this.transport.disconnect(clientId, reason)
  }
}
