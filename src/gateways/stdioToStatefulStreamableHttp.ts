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
import { StatefulSessions } from './statefulSessions.js'

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
    healthCheck,
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
    healthCheck,
    apiKeys,
  })
  logger.info(
    `  - Session timeout: ${sessionTimeout ? `${sessionTimeout}ms` : 'disabled'}`,
  )

  const children = new OwnedChildProcesses(logger)
  const modern = modernRelayFor(args, children, logger)

  const app = streamableHttpApp(express, cors, {
    headers,
    corsOrigin,
    exposedHeaders: ['Mcp-Session-Id'],
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
