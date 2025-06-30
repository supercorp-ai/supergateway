import express from 'express'
import bodyParser from 'body-parser'
import cors, { type CorsOptions } from 'cors'
import { ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { StdioChildProcessPool } from '../lib/stdioProcessPool.js'

export interface StdioToSseArgs {
  stdioCmds: string[]
  port: number
  baseUrl: string
  ssePath: string
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  minConcurrency: number
  maxConcurrency: number
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

const getEndpointName = (command: string): string => {
  const commandParts = command.split(' ').filter((p) => p && !p.startsWith('-'))
  let lastMeaningfulPart = ''
  for (let i = commandParts.length - 1; i >= 0; i--) {
    if (commandParts[i] !== '/' && commandParts[i] !== '.') {
      lastMeaningfulPart = commandParts[i]
      break
    }
  }
  if (!lastMeaningfulPart) return 'unknown'

  let finalName = lastMeaningfulPart
  if (finalName.includes('-mcp')) {
    finalName = finalName.split('-mcp')[0]
  } else if (finalName.startsWith('@') && finalName.includes('/')) {
    finalName = finalName.split('/').pop() || finalName
  }

  const nameParts = finalName.split(/[\/-]/)
  finalName = nameParts[nameParts.length - 1]
  return finalName.replace(/[^a-zA-Z0-9]/g, '') || 'unknown'
}

const setupServerRoutes = (
  app: express.Express,
  pool: StdioChildProcessPool,
  args: StdioToSseArgs & {
    ssePath: string
    messagePath: string
    name: string
    sessions: Record<
      string,
      { transport: SSEServerTransport; response: express.Response }
    >
  },
) => {
  const { baseUrl, ssePath, messagePath, logger, headers, sessions, name } =
    args

  app.get(ssePath, async (req, res) => {
    logger.info(`[${name}] New SSE connection from ${req.ip}`)
    setResponseHeaders({ res, headers })

    let child: ChildProcessWithoutNullStreams
    try {
      child = await pool.acquire()
    } catch (err) {
      logger.error(`[${name}] Failed to acquire child process:`, err)
      res.status(503).send('Service unavailable')
      return
    }

    const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)
    const server = new Server(
      { name: `supergateway-${name}`, version: getVersion() },
      { capabilities: {} },
    )
    await server.connect(sseTransport)

    const sessionId = sseTransport.sessionId
    if (sessionId) {
      sessions[sessionId] = { transport: sseTransport, response: res }
    }

    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      logger.info(
        `[${name}] SSE → Child (session ${sessionId}): ${JSON.stringify(msg)}`,
      )
      child.stdin.write(JSON.stringify(msg) + '\n')
    }

    sseTransport.onclose = () => {
      logger.info(`[${name}] SSE connection closed (session ${sessionId})`)
      delete sessions[sessionId]
    }

    sseTransport.onerror = (err) => {
      logger.error(`[${name}] SSE error (session ${sessionId}):`, err)
      delete sessions[sessionId]
    }

    let buffer = ''
    const onStdoutData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach((line) => {
        if (!line.trim()) return
        try {
          const jsonMsg = JSON.parse(line)
          logger.info(`[${name}] Child → SSE (session ${sessionId}):`, jsonMsg)
          sseTransport.send(jsonMsg)
        } catch (err) {
          logger.error(
            `[${name}] Child non-JSON (session ${sessionId}): ${line}`,
            err,
          )
        }
      })
    }
    child.stdout.on('data', onStdoutData)

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      logger.error(
        `[${name}] Child process exited (session ${sessionId}): code=${code}, signal=${signal}`,
      )
      server.close()
    }
    child.on('exit', onExit)

    req.on('close', () => {
      logger.info(`[${name}] Client disconnected (session ${sessionId})`)
      server.close()
      child.stdout.off('data', onStdoutData)
      child.off('exit', onExit)
      pool.release(child)
    })
  })

  app.post(messagePath, async (req, res) => {
    const sessionId = req.query.sessionId as string
    setResponseHeaders({ res, headers })

    if (!sessionId) {
      res.status(400).send('Missing sessionId parameter')
      return
    }

    const session = sessions[sessionId]
    if (session?.transport?.handlePostMessage) {
      logger.info(`[${name}] POST to SSE transport (session ${sessionId})`)
      await session.transport.handlePostMessage(req, res)
      return
    } else {
      res.status(503).send(`No active SSE connection for session ${sessionId}`)
      return
    }
  })
}

export async function stdioToSse(args: StdioToSseArgs) {
  const {
    stdioCmds,
    port,
    logger,
    corsOrigin,
    healthEndpoints,
    minConcurrency,
    maxConcurrency,
  } = args

  logger.info(
    `  - Headers: ${Object(args.headers).length ? JSON.stringify(args.headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  if (args.baseUrl) {
    logger.info(`  - baseUrl: ${args.baseUrl}`)
  }
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )
  if (minConcurrency > 1 || maxConcurrency > 1) {
    logger.info(`  - minConcurrency: ${minConcurrency}`)
    logger.info(`  - maxConcurrency: ${maxConcurrency}`)
  }

  onSignals({ logger })

  const sessions: Record<
    string,
    { transport: SSEServerTransport; response: express.Response }
  > = {}

  const app = express()
  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  const allMessagePathsToBypass = new Set<string>()

  if (stdioCmds.length === 1) {
    allMessagePathsToBypass.add(args.messagePath)
  } else {
    for (const stdioCmd of stdioCmds) {
      const name = getEndpointName(stdioCmd)
      const messagePathForServer = `/${name}${args.messagePath}`
      allMessagePathsToBypass.add(messagePathForServer)
    }
  }

  app.use((req, res, next) => {
    if (allMessagePathsToBypass.has(req.path)) {
      return next()
    }
    return bodyParser.json()(req, res, next)
  })

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({ res, headers: args.headers })
      res.send('ok')
    })
  }

  if (stdioCmds.length === 1) {
    const stdioCmd = stdioCmds[0]
    logger.info('----------------------------------------------------')
    logger.info(`Starting in single server mode for: "${stdioCmd}"`)
    logger.info(`  - SSE Endpoint: http://localhost:${port}${args.ssePath}`)
    logger.info(
      `  - Message Endpoint: http://localhost:${port}${args.messagePath}`,
    )

    const pool = new StdioChildProcessPool({
      stdioCmd,
      minConcurrency,
      maxConcurrency,
      logger,
    })

    setupServerRoutes(app, pool, { ...args, sessions, name: 'main' })
  } else {
    logger.info('----------------------------------------------------')
    logger.info(
      `Starting in multiplexer mode for ${stdioCmds.length} servers...`,
    )

    for (const stdioCmd of stdioCmds) {
      const name = getEndpointName(stdioCmd)
      const ssePathForServer = `/${name}${args.ssePath}`
      const messagePathForServer = `/${name}${args.messagePath}`

      logger.info('----------------------------------------------------')
      logger.info(`Registering server for command: "${stdioCmd}"`)
      logger.info(`  - Name: ${name}`)
      logger.info(
        `  - SSE Endpoint: http://localhost:${port}${ssePathForServer}`,
      )
      logger.info(
        `  - Message Endpoint: http://localhost:${port}${messagePathForServer}`,
      )

      const pool = new StdioChildProcessPool({
        stdioCmd,
        minConcurrency,
        maxConcurrency,
        logger,
      })

      setupServerRoutes(app, pool, {
        ...args,
        ssePath: ssePathForServer,
        messagePath: messagePathForServer,
        sessions,
        name,
      })
    }
  }

  app.listen(port, () => {
    logger.info('----------------------------------------------------')
    logger.info(`Supergateway is listening on port ${port}`)
    if (stdioCmds.length > 1) {
      logger.info('All registered server endpoints are listed above.')
    }
  })
}
