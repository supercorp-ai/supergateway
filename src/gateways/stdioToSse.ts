import express from 'express'
import bodyParser from 'body-parser'
import cors, { type CorsOptions } from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import {
  safeJsonStringify,
  safeJsonParse,
  JsonBuffer,
  sanitizeJsonObject,
} from '../lib/jsonBuffer.js'

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

  logger.info(
    `  - Headers: ${Object(headers).length ? safeJsonStringify(headers) : '(none)'}`,
  )
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

  onSignals({ logger })

  const child: ChildProcessWithoutNullStreams = spawn(stdioCmd, { shell: true })
  child.on('exit', (code, signal) => {
    logger.error(`Child exited: code=${code}, signal=${signal}`)
    process.exit(code ?? 1)
  })

  const server = new Server(
    { name: 'supergateway', version: getVersion() },
    { capabilities: {} },
  )

  const sessions: Record<
    string,
    { transport: SSEServerTransport; response: express.Response }
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
    await server.connect(sseTransport)

    const sessionId = sseTransport.sessionId
    if (sessionId) {
      sessions[sessionId] = { transport: sseTransport, response: res }
    }

    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      logger.info(
        `SSE → Child (session ${sessionId}): ${safeJsonStringify(msg)}`,
      )
      child.stdin.write(safeJsonStringify(msg) + '\n')
    }

    sseTransport.onclose = () => {
      logger.info(`SSE connection closed (session ${sessionId})`)
      delete sessions[sessionId]
    }

    sseTransport.onerror = (err) => {
      logger.error(`SSE error (session ${sessionId}):`, err)
      delete sessions[sessionId]
    }

    req.on('close', () => {
      logger.info(`Client disconnected (session ${sessionId})`)
      delete sessions[sessionId]
    })
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

  const jsonBuffer = new JsonBuffer(
    (jsonMsg) => {
      logger.info('Child → SSE:', jsonMsg)
      const sanitizedMsg = sanitizeJsonObject(jsonMsg)
      for (const [sid, session] of Object.entries(sessions)) {
        try {
          session.transport.send(sanitizedMsg)
        } catch (err) {
          logger.error(`Failed to send to session ${sid}:`, err)
          delete sessions[sid]
        }
      }
    },
    (error, rawData) => {
      logger.error(`Child JSON parsing error: ${error}`)
      logger.error(`Raw data: ${rawData.slice(0, 200)}...`)
    },
  )

  child.stdout.on('data', (chunk: Buffer) => {
    jsonBuffer.addChunk(chunk.toString('utf8'))
  })

  child.stderr.on('data', (chunk: Buffer) => {
    logger.error(`Child stderr: ${chunk.toString('utf8')}`)
  })

  child.on('close', () => {
    jsonBuffer.flush()
  })
}
