import { spawn } from 'child_process'
import { stdoutLines } from '../lib/stdoutLines.js'
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

export interface StdioToSseArgs {
  stdioCmd: string
  maxStdoutLineBytes?: number
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
    maxStdoutLineBytes,
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

  let stdoutFailed = false
  const children = new OwnedChildProcesses(logger)
  onSignals({ logger, cleanup: () => children.close(), drainStdin: true })

  const child = spawn(stdioCmd, children.spawnOptions)
  children.own(child)
  child.on('exit', (code, signal) => {
    logger.error(`Child exited: code=${code}, signal=${signal}`)
    void children
      .close()
      .then(() => process.exit(stdoutFailed ? 1 : (code ?? 1)))
  })

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

    const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)
    const sessionServer = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )
    await sessionServer.connect(sseTransport)

    // `SSEServerTransport.sessionId` is declared `string`, not `string |
    // undefined`: the SDK assigns it in the constructor. The guard that used to
    // wrap this could not be false, so it was an obligation no test could ever
    // discharge rather than a defence against anything.
    const sessionId = sseTransport.sessionId
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
      server.close().catch((err) => {
        logger.error(`Failed to close session ${sessionId}:`, err)
      })
    }

    sseTransport.onclose = () =>
      endSession(() =>
        logger.info(`SSE connection closed (session ${sessionId})`),
      )

    sseTransport.onerror = (err) =>
      endSession(() => logger.error(`SSE error (session ${sessionId}):`, err))

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

  child.stdout.on(
    'data',
    stdoutLines(
      maxStdoutLineBytes,
      (line) => {
        if (!line.trim()) return
        try {
          const jsonMsg = JSON.parse(line)
          logger.info('Child → SSE:', jsonMsg)
          for (const [sid, session] of Object.entries(sessions)) {
            // `send` is async: it reports failure by rejecting, so a synchronous
            // try/catch around it never ran and the rejection escaped to kill the
            // process. Attaching the handler here is also what makes the pruning
            // below reachable for the first time.
            session.transport.send(jsonMsg).catch((err) => {
              logger.error(`Failed to send to session ${sid}:`, err)
              delete sessions[sid]
            })
          }
        } catch {
          logger.error(`Child non-JSON: ${line}`)
        }
      },
      () => {
        stdoutFailed = true
        logger.error(
          `Child stdout line exceeds maxStdoutLineBytes (${maxStdoutLineBytes} bytes)`,
        )
        void children.close()
      },
    ),
  )

  child.stderr.on('data', (chunk: Buffer) => {
    logger.error(`Child stderr: ${chunk.toString('utf8')}`)
  })
}
