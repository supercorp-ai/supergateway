import { spawn } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
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

    const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)
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
      return
    }
    // A client can disappear while the SDK is starting the transport. Never
    // launch a child for a response that has already gone away.
    if (children.closing || res.destroyed || res.writableEnded) {
      await sessionServer
        .close()
        .catch((err) =>
          logger.error('Failed to close abandoned SSE session:', err),
        )
      return
    }

    // `SSEServerTransport.sessionId` is declared `string`, not `string |
    // undefined`: the SDK assigns it in the constructor. The guard that used to
    // wrap this could not be false, so it was an obligation no test could ever
    // discharge rather than a defence against anything.
    const sessionId = sseTransport.sessionId
    const child = spawn(stdioCmd, children.spawnOptions)
    const stopChild = children.own(child)
    sessions[sessionId] = {
      server: sessionServer,
      transport: sseTransport,
      response: res,
    }

    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      logger.info(`SSE → Child (session ${sessionId}): ${JSON.stringify(msg)}`)
      child.stdin.write(JSON.stringify(msg) + '\n')
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
    const endSession = (report: () => void) => {
      if (!sessions[sessionId]) return
      report()
      const { server } = sessions[sessionId]
      delete sessions[sessionId]
      void stopChild()
      server.close().catch((err) => {
        logger.error(`Failed to close session ${sessionId}:`, err)
      })
    }

    child.on('error', (err) => {
      logger.error(`Child failure (session ${sessionId}):`, err)
      endSession(() => {})
    })
    child.stdin.on('error', (err) => {
      logger.error(`Child stdin failure (session ${sessionId}):`, err)
      endSession(() => {})
    })
    child.on('exit', (code, signal) => {
      const detail = `Child exited (session ${sessionId}): code=${code}, signal=${signal}`
      if (!sessions[sessionId]) {
        logger.info(detail)
        return
      }
      logger.error(detail)
      endSession(() => {})
    })

    const decoder = new StringDecoder('utf8')
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop()!
      lines.forEach((line) => {
        if (!line.trim()) return
        try {
          const jsonMsg = JSON.parse(line)
          logger.info(`Child → SSE (session ${sessionId}):`, jsonMsg)
          if (!sessions[sessionId]) return
          sseTransport.send(jsonMsg).catch((err) => {
            endSession(() =>
              logger.error(`Failed to send to session ${sessionId}:`, err),
            )
          })
        } catch {
          logger.error(`Child non-JSON (session ${sessionId}): ${line}`)
        }
      })
    })
    child.stderr.on('data', (chunk: Buffer) => {
      logger.error(
        `Child stderr (session ${sessionId}): ${chunk.toString('utf8')}`,
      )
    })

    sseTransport.onclose = () =>
      endSession(() =>
        logger.info(`SSE connection closed (session ${sessionId})`),
      )

    // The SDK also calls `onerror` for a single rejected POST (bad content
    // type, oversized body, invalid JSON-RPC). The SSE stream is still alive;
    // `onclose` and the client socket close handle actual session teardown.
    sseTransport.onerror = (err) =>
      logger.error(`SSE error (session ${sessionId}):`, err)

    req.on('close', () =>
      endSession(() =>
        logger.info(`Client disconnected (session ${sessionId})`),
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

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`)
    logger.info(`POST messages: http://localhost:${port}${messagePath}`)
  })
}
