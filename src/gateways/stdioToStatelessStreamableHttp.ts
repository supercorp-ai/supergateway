import type { Logger } from '../types.js'
import cors, { type CorsOptions } from 'cors'
import { type HealthCheck, serverHealthOf } from '../lib/serverHealth.js'
import { type ServerSource, startServer } from '../lib/serverSource.js'
import { onSignals } from '../lib/onSignals.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { listenOn, endpointHost } from '../lib/listenHost.js'
import type { Mount } from '../lib/serve.js'
import { announceGateway } from '../lib/gatewayListing.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { modernRelayFor } from '../lib/modernHttp.js'
import { streamableHttpApp } from '../lib/streamableHttpApp.js'
import express from 'express'
import { spawn } from 'child_process'
import { StatelessRequest } from './statelessRequest.js'

interface StdioToStreamableHttpOptions {
  port: number
  /** The address to listen on; every interface when unset. */
  host?: string
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  /** What the health endpoints check; the gateway alone by default. */
  healthCheck?: HealthCheck
  headers: Record<string, string>
  // The keys a client must present; none, or left out, means no check.
  apiKeys?: string[]
  protocolVersion: string
}

/** A server and how it is served over Streamable HTTP. */
export type StdioToStreamableHttpArgs = ServerSource &
  StdioToStreamableHttpOptions

export async function stdioToStatelessStreamableHttp(
  args: StdioToStreamableHttpArgs,
) {
  const { port, host, logger } = args
  const mount = stdioToStatelessStreamableHttpMount(args)
  onSignals({ logger, cleanup: mount.close, drainStdin: true })
  keepConnectionsAlive(
    listenOn(mount.app, port, host, () => {
      logger.info(`Listening on port ${port}`)
      mount.listening(host, port)
    }),
  )
}

export function stdioToStatelessStreamableHttpMount(
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
    healthCheck,
    headers,
    apiKeys = [],
    path = '/',
    protocolVersion,
  } = args

  announceGateway(logger, {
    headers,
    port,
    host,
    source: args,
    settings: [
      `streamableHttpPath: ${streamableHttpPath}`,
      `protocolVersion: ${protocolVersion}`,
    ],
    corsOrigin,
    healthEndpoints,
    healthCheck,
    apiKeys,
  })

  const children = new OwnedChildProcesses(logger)
  const modern = modernRelayFor(args, children, logger)

  const app = streamableHttpApp(express, cors, {
    headers,
    corsOrigin,
    healthEndpoints,
    health: serverHealthOf(
      healthCheck,
      children,
      (quiet) => startServer(spawn, args, children, quiet, 'Health check'),
      logger,
    ),
    apiKeys,
    logger,
  })

  app.post(streamableHttpPath, async (req, res) => {
    if (children.closing) {
      res.status(503).send('Gateway is shutting down')
      return
    }
    if (await modern?.handle(req, res)) return
    // In stateless mode, create a new instance of transport and server for each request
    // to ensure complete isolation. A single instance would cause request ID collisions
    // when multiple clients connect concurrently.
    try {
      await StatelessRequest.serve(
        args,
        children,
        logger,
        protocolVersion,
        req,
        res,
      )
    } catch (error) {
      logger.error('Error handling MCP request:', error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        })
      }
    }
  })

  // Every request is a POST: there is no session to stream from or to end.
  const notAllowed =
    (method: string) =>
    async (_req: express.Request, res: express.Response) => {
      logger.info(`Received ${method} MCP request`)
      res.writeHead(405).end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Method not allowed.',
          },
          id: null,
        }),
      )
    }
  app.get(streamableHttpPath, notAllowed('GET'))
  app.delete(streamableHttpPath, notAllowed('DELETE'))

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
