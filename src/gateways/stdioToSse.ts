import { spawn } from 'child_process'
import express from 'express'
import bodyParser from 'body-parser'
import cors, { type CorsOptions } from 'cors'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { escapeSseJsonSeparators } from '../lib/escapeSseJsonSeparators.js'
import { endpointHost, listenOn } from '../lib/listenHost.js'
import type { Mount } from '../lib/serve.js'
import { setResponseHeaders } from '../lib/headers.js'
import { announceGateway } from '../lib/gatewayListing.js'
import { onSignals } from '../lib/onSignals.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { drained } from '../lib/outputBackpressure.js'
import {
  ChildHandoff,
  type ChildOwner,
  type StartPeer,
} from '../lib/childHandoff.js'
import { ConnectionChild } from '../lib/connectionChild.js'
import { requireApiKey } from '../lib/apiKey.js'
import { startServer, type ServerSource } from '../lib/serverSource.js'

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
    apiKeys,
  })

  const children = new OwnedChildProcesses(logger)
  const handoff = new ChildHandoff(logger)

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

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders(res, headers)
      res.send('ok')
    })
  }

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
    new SseSession(sessions, sseTransport, sessionServer, res, logger).start(
      req,
      startServer(
        spawn,
        args,
        children,
        logger,
        `Session ${sseTransport.sessionId}`,
      ),
      handoff,
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

type SseSessions = Record<
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
class SseSession {
  // `SSEServerTransport.sessionId` is declared `string`, not `string |
  // undefined`: the SDK assigns it in the constructor. The guard that used to
  // wrap this could not be false, so it was an obligation no test could ever
  // discharge rather than a defence against anything.
  private readonly sessionId: string
  private readonly label: string
  // The client's calls the child has not answered yet.
  private readonly pending = new Set<string | number>()
  private connection!: ConnectionChild

  constructor(
    private readonly sessions: SseSessions,
    private readonly transport: SSEServerTransport,
    server: Server,
    private readonly res: express.Response,
    private readonly logger: Logger,
  ) {
    this.sessionId = transport.sessionId
    this.label = `Session ${this.sessionId}`
    sessions[this.sessionId] = { server, transport, response: res }
  }

  /** Starts the session's child, and listens to the client and the stream. */
  start(req: express.Request, server: StartPeer, handoff: ChildHandoff) {
    const { logger, sessionId, transport } = this
    this.connection = new ConnectionChild(
      server,
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
