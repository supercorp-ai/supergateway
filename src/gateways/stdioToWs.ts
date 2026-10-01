import { spawn } from 'child_process'
import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { createServer } from 'http'
import { Logger } from '../types.js'
import { WebSocketServerTransport } from '../server/websocket.js'
import { onSignals } from '../lib/onSignals.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { ChildInitialization } from '../lib/childInitialization.js'
import {
  ChildHandoff,
  ChildLink,
  type ChildOwner,
} from '../lib/childHandoff.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

export interface StdioToWsArgs {
  stdioCmd: string
  port: number
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
}

export async function stdioToWs(args: StdioToWsArgs) {
  const { stdioCmd, port, messagePath, logger, healthEndpoints, corsOrigin } =
    args
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - messagePath: ${messagePath}`)
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  const children = new OwnedChildProcesses(logger)
  // Each connection has its own child, as each SSE connection does since
  // #221. With one child shared by every client, notifications and the
  // server's own requests could only be broadcast: one client received
  // another's logs and progress, and could be asked to answer its sampling.
  const connections = new Map<
    string,
    {
      link: ChildLink
      owner: ChildOwner
      initialization: ChildInitialization
      // Whether all the client has sent is its initialize request, which is
      // when a child it abandons can be handed to an identical retry (GW-035).
      received: number
      onlyInitialize: boolean
    }
  >()
  const handoff = new ChildHandoff(logger)

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

  // @types/express declares RequestHandler as returning `void | Promise<void>`,
  // and Application extends it, so the rule sees a possibly-async handler.
  // Express 4's app is not one: it is `function (req, res, next) {
  // app.handle(req, res, next) }` — arity 3, returns undefined. Passing it to
  // http.createServer is the documented pattern, so this is a declaration
  // artifact rather than a floating promise.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const httpServer = keepConnectionsAlive(createServer(app))

  // A connection's child is stopped once, whichever ending comes first: the
  // client leaving, the child exiting, or its stdio failing. Only the client
  // leaving can hand the child on instead.
  const end = (clientId: string, reason: string, clientLeft = false) => {
    const connection = connections.get(clientId)
    if (!connection) return
    connections.delete(clientId)
    if (clientLeft)
      handoff.release(
        connection.link,
        connection.onlyInitialize,
        `Client ${clientId}`,
      )
    else void connection.link.stop()
    wsTransport.disconnect(clientId, reason)
  }

  const wsTransport: WebSocketServerTransport = new WebSocketServerTransport(
    { path: messagePath, server: httpServer },
    {
      onconnection: (clientId) => {
        logger.info(`New WebSocket connection: ${clientId}`)
        let child
        try {
          child = spawn(stdioCmd, children.spawnOptions)
        } catch (err) {
          // Thrown inside the socket's connection event it would take down
          // the gateway and every other client with it.
          logger.error(
            `Failed to start the MCP server (client ${clientId}):`,
            err,
          )
          wsTransport.disconnect(clientId, 'MCP server process failed')
          return
        }
        // What this connection has sent the client since its stdout was
        // last read, for the child to wait on.
        let sent: Promise<void> | undefined
        const owner: ChildOwner = {
          message: (message, line) => {
            if (initialization.fromChild(message)) return
            logger.info(`Child → WebSocket (client ${clientId}): ${line}`)
            sent = wsTransport.send(message, clientId)
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
            end(clientId, 'MCP server process failed')
          },
          exit: (code, signal) => {
            logger.info(
              `Child exited (client ${clientId}): code=${code}, signal=${signal}`,
            )
            end(clientId, 'MCP server process exited')
          },
          output: () => {
            const pending = sent
            sent = undefined
            return pending
          },
        }
        const connection = {
          link: new ChildLink(child, children.own(child), owner),
          owner,
          // A client that reconnects and carries on without initializing gets
          // its new child initialized by the gateway (GW-034).
          initialization: new ChildInitialization(
            (message) => connection.link.write(message),
            logger,
            `Client ${clientId}`,
          ),
          received: 0,
          onlyInitialize: false,
        }
        const { initialization } = connection
        connections.set(clientId, connection)
      },
      onmessage: (message, clientId) => {
        const line = JSON.stringify(message)
        const connection = connections.get(clientId)
        // A frame can still arrive after the child ended, while the socket
        // `end` closed is finishing its close handshake.
        if (!connection) {
          logger.info(`Dropped a message for ended client ${clientId}`)
          return
        }
        logger.info(`WebSocket → Child (client ${clientId}): ${line}`)
        connection.received++
        connection.onlyInitialize =
          connection.received === 1 &&
          isInitializeRequest(message) &&
          'id' in message
        if (connection.onlyInitialize) {
          const adopted = handoff.adopt(
            message,
            connection.owner,
            `Client ${clientId}`,
          )
          if (adopted) {
            // This connection's own child has been sent nothing.
            handoff.discard(connection.link, `Client ${clientId}`)
            connection.link = adopted
            connection.initialization.adopted()
            return
          }
        }
        connection.initialization.fromClient(message)
      },
      ondisconnection: (clientId) => {
        logger.info(`WebSocket connection closed: ${clientId}`)
        end(clientId, 'Client disconnected', true)
      },
      onerror: (err) => {
        logger.error(`WebSocket error: ${err.message}`)
      },
    },
  )

  onSignals({
    logger,
    cleanup: async () => {
      await Promise.all([wsTransport.close(), children.close()])
    },
    drainStdin: true,
  })

  wsTransport.start()

  httpServer.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`WebSocket endpoint: ws://localhost:${port}${messagePath}`)
  })
}
