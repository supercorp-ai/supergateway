import { spawn } from 'child_process'
import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { createServer } from 'http'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { WebSocketServerTransport } from '../server/websocket.js'
import { onSignals } from '../lib/onSignals.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { announceHost, endpointHost, listenOn } from '../lib/listenHost.js'
import { ChildHandoff, type ChildOwner } from '../lib/childHandoff.js'
import { ConnectionChild } from '../lib/connectionChild.js'
import { logApiKeys, requireApiKey, verifyApiKey } from '../lib/apiKey.js'
import {
  describeCommand,
  spawnCommand,
  type ChildCommand,
} from '../lib/childCommand.js'

export interface StdioToWsArgs {
  stdioCmd: ChildCommand
  port: number
  /** The address to listen on; every interface when unset. */
  host?: string
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  // The keys a client must present; none, or left out, means no check.
  apiKeys?: string[]
}

/**
 * The WebSocket clients and their children. Each connection has its own child,
 * as each SSE connection does since #221. With one child shared by every
 * client, notifications and the server's own requests could only be
 * broadcast: one client received another's logs and progress, and could be
 * asked to answer its sampling.
 */
class WsConnections {
  private readonly connections = new Map<string, ConnectionChild>()
  // Assigned as soon as the transport exists: it is built with this object's
  // handlers, and calls none of them before it starts.
  transport!: WebSocketServerTransport

  constructor(
    private readonly stdioCmd: ChildCommand,
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
    let child
    try {
      child = spawnCommand(spawn, this.stdioCmd, this.children.spawnOptions)
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
      child,
      this.children.own(child),
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

export async function stdioToWs(args: StdioToWsArgs) {
  const {
    stdioCmd,
    port,
    host,
    messagePath,
    logger,
    healthEndpoints,
    corsOrigin,
    apiKeys = [],
  } = args
  logger.info(`  - port: ${port}`)
  announceHost(logger, host)
  logger.info(`  - stdio: ${describeCommand(stdioCmd)}`)
  logger.info(`  - messagePath: ${messagePath}`)
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )
  logApiKeys(logger, apiKeys)

  const children = new OwnedChildProcesses(logger)
  const connections = new WsConnections(
    stdioCmd,
    children,
    new ChildHandoff(logger),
    logger,
  )

  const app = express()

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  // With no process-wide child there is nothing to report but that the
  // gateway is up, as in SSE mode.
  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      res.send('ok')
    })
  }

  // Plain HTTP requests; the upgrade itself is checked by `verifyClient`.
  app.use(requireApiKey(apiKeys, logger))

  // @types/express declares RequestHandler as returning `void | Promise<void>`,
  // and Application extends it, so the rule sees a possibly-async handler.
  // Express 4's app is not one: it is `function (req, res, next) {
  // app.handle(req, res, next) }` — arity 3, returns undefined. Passing it to
  // http.createServer is the documented pattern, so this is a declaration
  // artifact rather than a floating promise.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const httpServer = keepConnectionsAlive(createServer(app))

  const wsTransport = new WebSocketServerTransport(
    {
      path: messagePath,
      server: httpServer,
      verifyClient: verifyApiKey(apiKeys, logger),
    },
    {
      onconnection: (clientId) => connections.open(clientId),
      onmessage: (message, clientId) =>
        connections.fromClient(message, clientId),
      ondisconnection: (clientId) => {
        logger.info(`WebSocket connection closed: ${clientId}`)
        connections.end(clientId, 'Client disconnected', true)
      },
      onerror: (err) => {
        logger.error(`WebSocket error: ${err.message}`)
      },
    },
  )
  connections.transport = wsTransport

  onSignals({
    logger,
    cleanup: async () => {
      await Promise.all([wsTransport.close(), children.close()])
    },
    drainStdin: true,
  })

  wsTransport.start()

  listenOn(httpServer, port, host, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(
      `WebSocket endpoint: ws://${endpointHost(host)}:${port}${messagePath}`,
    )
  })
}
