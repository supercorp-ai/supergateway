import type { Logger } from '../types.js'
import cors, { type CorsOptions } from 'cors'
import {
  type HealthCheck,
  serverHealthOf,
  healthHandler,
} from '../lib/serverHealth.js'
import { type ServerSource, startServer } from '../lib/serverSource.js'
import { onSignals } from '../lib/onSignals.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { listenOn, endpointHost } from '../lib/listenHost.js'
import type { Mount } from '../lib/serve.js'
import { announceGateway } from '../lib/gatewayListing.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { ChildHandoff } from '../lib/childHandoff.js'
import { spawn } from 'child_process'
import { type SseSessions, SseSession } from './sseSession.js'
import express from 'express'
import { escapeSseJsonSeparators } from '../lib/escapeSseJsonSeparators.js'
import bodyParser from 'body-parser'
import { setResponseHeaders } from '../lib/headers.js'
import { requireApiKey } from '../lib/apiKey.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { getVersion } from '../lib/getVersion.js'

interface StdioToSseOptions {
  port: number
  /** The address to listen on; every interface when unset. */
  host?: string
  baseUrl: string
  ssePath: string
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  /** What the health endpoints check; the gateway alone by default. */
  healthCheck?: HealthCheck
  headers: Record<string, string>
  // The keys a client must present; none, or left out, means no check.
  apiKeys?: string[]
}

/**
 * One SSE server among those a gateway serves. The port is the gateway's:
 * given, it is announced with the server's settings, as it is when the
 * server has the port to itself.
 */
/** A server and how it is served over SSE. */
export type StdioToSseArgs = ServerSource & StdioToSseOptions

export type StdioToSseMountArgs = ServerSource &
  Omit<StdioToSseOptions, 'port'> & {
    port?: number
    /** The URL path the server's requests start with; `/` by default. */
    path?: string
  }

export async function stdioToSse(args: StdioToSseArgs) {
  const { port, host, logger } = args
  const mount = stdioToSseMount(args)
  onSignals({ logger, cleanup: mount.close, drainStdin: true })
  keepConnectionsAlive(
    listenOn(mount.app, port, host, () => {
      logger.info(`Listening on port ${port}`)
      mount.listening(host, port)
    }),
  )
}

export function stdioToSseMount(args: StdioToSseMountArgs): Mount {
  const {
    port,
    host,
    baseUrl,
    ssePath,
    messagePath,
    logger,
    corsOrigin,
    healthEndpoints,
    healthCheck,
    headers,
    apiKeys = [],
    path = '/',
  } = args

  announceGateway(logger, {
    headers,
    port,
    host,
    source: args,
    settings: [
      ...(baseUrl ? [`baseUrl: ${baseUrl}`] : []),
      `ssePath: ${ssePath}`,
      `messagePath: ${messagePath}`,
    ],
    corsOrigin,
    healthEndpoints,
    healthCheck,
    apiKeys,
  })

  const children = new OwnedChildProcesses(logger)
  const handoff = new ChildHandoff(logger)
  const health = serverHealthOf(
    healthCheck,
    children,
    (quiet) => startServer(spawn, args, children, quiet, 'Health check'),
    logger,
  )

  // One `Server` per session, not one per process.
  //
  // `Protocol.connect` assigns `this._transport`, and from SDK 1.26 it throws
  // `Already connected to a transport` when that field is already set. A single
  // shared `Server` therefore served exactly one connection per process
  // lifetime: the second client crashed it, and so did the same client
  // reconnecting after a dropped stream — the throw lands in an async Express
  // handler with nothing to catch it, and the unhandled rejection takes the
  // process down. Reconnecting is ordinary, not an edge case, which is what
  // made this the most reported crash in the tracker (#112, #138, #153).
  //
  // The shape is taken from @sfasching's #113.
  const sessions: SseSessions = {}

  const app = express()
  app.use((_req, res, next) => {
    escapeSseJsonSeparators(res)
    next()
  })

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  app.use((req, res, next) => {
    if (req.path === messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  for (const ep of healthEndpoints)
    app.get(
      ep,
      healthHandler(health, (res) => setResponseHeaders(res, headers)),
    )

  // After CORS and the health endpoints, which stay open; before the stream
  // and the message endpoint.
  app.use(requireApiKey(apiKeys, logger))

  // A new connection's transport and the session's own `Server`, connected; or
  // nothing, when either failed or the client was gone before it finished.
  const openSseTransport = async (res: express.Response) => {
    // Without its trailing slash, `https://host/` would give `//message`,
    // which a client reads as a URL on a host named "message".
    const sseTransport = new SSEServerTransport(
      `${baseUrl.replace(/\/+$/, '')}${messagePath}`,
      res,
    )
    const sessionServer = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )
    try {
      await sessionServer.connect(sseTransport)
    } catch (err) {
      logger.error('Failed to open SSE session:', err)
      await sessionServer
        .close()
        .catch((closeErr) =>
          logger.error('Failed to close rejected SSE session:', closeErr),
        )
      if (!res.headersSent) res.status(500).end()
      else res.destroy()
      return undefined
    }
    // A client can disappear while the SDK is starting the transport. Never
    // launch a child for a response that has already gone away.
    if (children.closing || res.destroyed || res.writableEnded) {
      await sessionServer
        .close()
        .catch((err) =>
          logger.error('Failed to close abandoned SSE session:', err),
        )
      return undefined
    }
    return { sseTransport, sessionServer }
  }

  app.get(ssePath, async (req, res) => {
    logger.info(`New SSE connection from ${req.ip}`)

    setResponseHeaders(res, headers)
    if (children.closing) {
      res.status(503).send('Gateway is shutting down')
      return
    }

    const opened = await openSseTransport(res)
    if (!opened) return
    const { sseTransport, sessionServer } = opened
    new SseSession(
      sessions,
      sseTransport,
      sessionServer,
      req,
      res,
      startServer(
        spawn,
        args,
        children,
        logger,
        `Session ${sseTransport.sessionId}`,
      ),
      handoff,
      logger,
    )
  })

  // @ts-ignore
  app.post(messagePath, async (req, res) => {
    const sessionId = req.query.sessionId as string

    setResponseHeaders(res, headers)

    if (!sessionId) {
      return res.status(400).send('Missing sessionId parameter')
    }

    const session = sessions[sessionId]
    // A session is stored with its transport, and kept only while it is open.
    if (session) {
      logger.info(`POST to SSE transport (session ${sessionId})`)
      await session.transport.handlePostMessage(req, res)
    } else {
      res.status(503).send(`No active SSE connection for session ${sessionId}`)
    }
  })

  return {
    app,
    path,
    listening: (listenHost, listenPort) => {
      logger.info(
        `SSE endpoint: http://${endpointHost(listenHost)}:${listenPort}${ssePath}`,
      )
      logger.info(
        `POST messages: http://${endpointHost(listenHost)}:${listenPort}${messagePath}`,
      )
    },
    close: () => children.close(),
  }
}
