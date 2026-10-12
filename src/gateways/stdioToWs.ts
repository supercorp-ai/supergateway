import type { Logger } from '../types.js'
import cors, { type CorsOptions } from 'cors'
import {
  type HealthCheck,
  serverHealthOf,
  healthHandler,
} from '../lib/serverHealth.js'
import { type ServerSource, startServer } from '../lib/serverSource.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { createServer } from 'http'
import { onSignals } from '../lib/onSignals.js'
import { listenOn, endpointHost } from '../lib/listenHost.js'
import type { Mount } from '../lib/serve.js'
import { announceGateway } from '../lib/gatewayListing.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { WsConnections } from './wsConnections.js'
import { ChildHandoff } from '../lib/childHandoff.js'
import express from 'express'
import { spawn } from 'child_process'
import { requireApiKey, verifyApiKey } from '../lib/apiKey.js'
import { WebSocketServerTransport } from '../server/websocket.js'

interface StdioToWsOptions {
  port: number
  /** The address to listen on; every interface when unset. */
  host?: string
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  /** What the health endpoints check; the gateway alone by default. */
  healthCheck?: HealthCheck
  // The keys a client must present; none, or left out, means no check.
  apiKeys?: string[]
}

/**
 * One WebSocket server among those a gateway serves. The port is the
 * gateway's: given, it is announced with the server's settings, as it is
 * when the server has the port to itself.
 */
/** A server and how it is served over WebSocket. */
export type StdioToWsArgs = ServerSource & StdioToWsOptions

export type StdioToWsMountArgs = ServerSource &
  Omit<StdioToWsOptions, 'port'> & {
    port?: number
    /** The URL path the server's requests start with; `/` by default. */
    path?: string
  }

export async function stdioToWs(args: StdioToWsArgs) {
  const { port, host, logger } = args
  const mount = stdioToWsMount(args)
  // @types/express declares RequestHandler as returning `void | Promise<void>`,
  // and Application extends it, so the rule sees a possibly-async handler.
  // Express 4's app is not one: it is `function (req, res, next) {
  // app.handle(req, res, next) }` — arity 3, returns undefined. Passing it to
  // http.createServer is the documented pattern, so this is a declaration
  // artifact rather than a floating promise.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const httpServer = keepConnectionsAlive(createServer(mount.app))
  httpServer.on('upgrade', mount.upgrade.handle)
  onSignals({ logger, cleanup: mount.close, drainStdin: true })
  listenOn(httpServer, port, host, () => {
    logger.info(`Listening on port ${port}`)
    mount.listening(host, port)
  })
}

export function stdioToWsMount(args: StdioToWsMountArgs): Required<Mount> {
  const {
    port,
    host,
    messagePath,
    logger,
    healthEndpoints,
    healthCheck,
    corsOrigin,
    apiKeys = [],
    path = '/',
  } = args
  announceGateway(logger, {
    port,
    host,
    source: args,
    settings: [`messagePath: ${messagePath}`],
    corsOrigin,
    healthEndpoints,
    healthCheck,
    apiKeys,
  })

  const children = new OwnedChildProcesses(logger)
  const connections = new WsConnections(
    args,
    children,
    new ChildHandoff(logger),
    logger,
  )

  const app = express()

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  // With no process-wide child, the gateway alone is up, or, with
  // --healthCheck server, a server started for the check answers.
  const health = serverHealthOf(
    healthCheck,
    children,
    (quiet) => startServer(spawn, args, children, quiet, 'Health check'),
    logger,
  )
  for (const ep of healthEndpoints) app.get(ep, healthHandler(health))

  // Plain HTTP requests; the upgrade itself is checked by `verifyClient`.
  app.use(requireApiKey(apiKeys, logger))

  const wsTransport = new WebSocketServerTransport(
    {
      path: messagePath,
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

  wsTransport.start()

  return {
    app,
    path,
    upgrade: {
      path: messagePath,
      handle: (req, socket, head) =>
        wsTransport.handleUpgrade(req, socket, head),
    },
    listening: (listenHost, listenPort) =>
      logger.info(
        `WebSocket endpoint: ws://${endpointHost(listenHost)}:${listenPort}${messagePath}`,
      ),
    close: async () => {
      await Promise.all([wsTransport.close(), children.close()])
    },
  }
}
