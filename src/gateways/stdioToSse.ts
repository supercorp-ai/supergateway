import { spawn } from 'child_process'
import express from 'express'
import bodyParser from 'body-parser'
import cors, { type CorsOptions } from 'cors'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { describeHeaders } from '../lib/headers.js'
import { escapeSseJsonSeparators } from '../lib/escapeSseJsonSeparators.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { drained } from '../lib/outputBackpressure.js'
import { ChildHandoff, type ChildOwner } from '../lib/childHandoff.js'
import { ConnectionChild } from '../lib/connectionChild.js'

export interface StdioToSseArgs {
  stdioCmd: string
  port: number
  baseUrl: string
  ssePath: string
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
}

const setResponseHeaders = ({
  res,
  headers,
}: {
  res: express.Response
  headers: Record<string, string>
}) =>
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

export async function stdioToSse(args: StdioToSseArgs) {
  const {
    stdioCmd,
    port,
    baseUrl,
    ssePath,
    messagePath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
  } = args

  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  if (baseUrl) {
    logger.info(`  - baseUrl: ${baseUrl}`)
  }
  logger.info(`  - ssePath: ${ssePath}`)
  logger.info(`  - messagePath: ${messagePath}`)

  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  const children = new OwnedChildProcesses(logger)
  const handoff = new ChildHandoff(logger)
  onSignals({ logger, cleanup: () => children.close(), drainStdin: true })

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
  const sessions: Record<
    string,
    {
      server: Server
      transport: SSEServerTransport
      response: express.Response
    }
  > = {}

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
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

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

    setResponseHeaders({
      res,
      headers,
    })
    if (children.closing) {
      res.status(503).send('Gateway is shutting down')
      return
    }

    const opened = await openSseTransport(res)
    if (!opened) return
    const { sseTransport, sessionServer } = opened

    // `SSEServerTransport.sessionId` is declared `string`, not `string |
    // undefined`: the SDK assigns it in the constructor. The guard that used to
    // wrap this could not be false, so it was an obligation no test could ever
    // discharge rather than a defence against anything.
    const sessionId = sseTransport.sessionId
    const label = `Session ${sessionId}`
    sessions[sessionId] = {
      server: sessionServer,
      transport: sseTransport,
      response: res,
    }

    // The client's calls the child has not answered yet.
    const pending = new Set<string | number>()

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
    const endSession = (report: () => void, clientLeft = false) => {
      if (!sessions[sessionId]) return
      report()
      const { server } = sessions[sessionId]
      delete sessions[sessionId]
      connection.end(clientLeft)
      server.close().catch((err) => {
        logger.error(`Failed to close session ${sessionId}:`, err)
      })
    }

    // A child that fails with calls in flight used to end the session
    // silently, and the SSE client waited out its own timeout on each one (60
    // seconds by default). Answer them first, as stateful HTTP does, then end.
    const fail = () => {
      // `send` writes to the stream before it returns, so the replies are
      // queued ahead of the close. One that cannot be sent is a stream already
      // gone; the session ends regardless, and at once, so no new message is
      // accepted for a server that is not there.
      void Promise.allSettled(
        [...pending].map((id) =>
          sseTransport.send({
            jsonrpc: '2.0',
            id,
            error: { code: -32603, message: 'MCP server process failed' },
          }),
        ),
      )
      pending.clear()
      endSession(() => {})
    }

    const owner: ChildOwner = {
      message: (jsonMsg) => {
        if ('id' in jsonMsg && !('method' in jsonMsg))
          pending.delete(jsonMsg.id)
        logger.info(`Child → SSE (session ${sessionId}):`, jsonMsg)
        if (!sessions[sessionId]) return
        sseTransport.send(jsonMsg).catch((err) => {
          endSession(() =>
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
        fail()
      },
      exit: (code, signal) => {
        const detail = `Child exited (session ${sessionId}): code=${code}, signal=${signal}`
        if (!sessions[sessionId]) {
          logger.info(detail)
          return
        }
        logger.error(detail)
        fail()
      },
      output: () => drained([res]),
    }

    const child = spawn(stdioCmd, children.spawnOptions)
    const connection = new ConnectionChild(
      child,
      children.own(child),
      owner,
      handoff,
      logger,
      label,
    )

    sseTransport.onmessage = (msg: JSONRPCMessage, extra) => {
      if ('id' in msg && 'method' in msg) pending.add(msg.id!)
      logger.info(`SSE → Child (session ${sessionId}): ${JSON.stringify(msg)}`)
      const version = extra?.requestInfo?.headers['mcp-protocol-version']
      connection.fromClient(
        msg,
        typeof version === 'string' ? version : undefined,
      )
    }

    sseTransport.onclose = () =>
      endSession(
        () => logger.info(`SSE connection closed (session ${sessionId})`),
        true,
      )

    // The SDK also calls `onerror` for a single rejected POST (bad content
    // type, oversized body, invalid JSON-RPC). The SSE stream is still alive;
    // `onclose` and the client socket close handle actual session teardown.
    sseTransport.onerror = (err) =>
      logger.error(`SSE error (session ${sessionId}):`, err)

    req.on('close', () =>
      endSession(
        () => logger.info(`Client disconnected (session ${sessionId})`),
        true,
      ),
    )
  })

  // @ts-ignore
  app.post(messagePath, async (req, res) => {
    const sessionId = req.query.sessionId as string

    setResponseHeaders({
      res,
      headers,
    })

    if (!sessionId) {
      return res.status(400).send('Missing sessionId parameter')
    }

    const session = sessions[sessionId]
    if (session?.transport?.handlePostMessage) {
      logger.info(`POST to SSE transport (session ${sessionId})`)
      await session.transport.handlePostMessage(req, res)
    } else {
      res.status(503).send(`No active SSE connection for session ${sessionId}`)
    }
  })

  keepConnectionsAlive(
    app.listen(port, () => {
      logger.info(`Listening on port ${port}`)
      logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`)
      logger.info(`POST messages: http://localhost:${port}${messagePath}`)
    }),
  )
}
