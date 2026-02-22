import express from 'express'
import bodyParser from 'body-parser'
import cors, { type CorsOptions } from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger, MultiStdioServerConfig } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

interface StdioToSseArgs {
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

interface MultiStdioToSseArgs {
  servers: MultiStdioServerConfig[]
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

const joinPath = (base: string, suffix: string) => {
  const normalizedBase = base === '/' ? '' : base.replace(/\/$/, '')
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${normalizedBase}${normalizedSuffix}` || '/'
}

export async function stdioToSse(args: StdioToSseArgs, app: express.Express) {
  const { stdioCmd, ...rest } = args

  return multiStdioToSse(
    {
      ...rest,
      servers: [
        {
          path: '/',
          stdioCmd,
        },
      ],
    },
    app,
  )
}

export async function multiStdioToSse(
  args: MultiStdioToSseArgs,
  app: express.Express,
) {
  const {
    servers,
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
    `  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  if (servers.length === 1 && servers[0]?.path === '/') {
    logger.info(`  - stdio: ${servers[0].stdioCmd}`)
    if (baseUrl) {
      logger.info(`  - baseUrl: ${baseUrl}`)
    }
    logger.info(`  - ssePath: ${ssePath}`)
    logger.info(`  - messagePath: ${messagePath}`)
  } else {
    logger.info('  - multi-server mappings:')
    for (const server of servers) {
      const fullSsePath = joinPath(server.path || '/', ssePath)
      const fullMessagePath = joinPath(server.path || '/', messagePath)
      logger.info(
        `    SSE: ${fullSsePath}, messages: ${fullMessagePath} -> ${server.stdioCmd}`,
      )
    }
    if (baseUrl) {
      logger.info(`  - baseUrl: ${baseUrl}`)
    }
  }

  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  app.use((req, res, next) => {
    // body for all non-message endpoints; message endpoints are handled by SSE transport
    const isMessageEndpoint = servers.some((server) => {
      const fullMessagePath = joinPath(server.path || '/', messagePath)
      return req.path === fullMessagePath
    })
    if (isMessageEndpoint) return next()
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

  type SessionInfo = {
    transport: SSEServerTransport
    response: express.Response
  }

  // One Server instance per stdio-backed MCP server
  const serversState = servers.map((serverConfig) => {
    const child: ChildProcessWithoutNullStreams = spawn(serverConfig.stdioCmd, {
      shell: true,
    })

    child.on('exit', (code, signal) => {
      logger.error(
        `Child exited for ${serverConfig.path || '/'}: code=${code}, signal=${signal}`,
      )
      process.exit(code ?? 1)
    })

    const sessions: Record<string, SessionInfo> = {}

    const fullSsePath = joinPath(serverConfig.path || '/', ssePath)
    const fullMessagePath = joinPath(serverConfig.path || '/', messagePath)

    app.get(fullSsePath, async (req, res) => {
      logger.info(
        `New SSE connection from ${req.ip} on ${fullSsePath} (${serverConfig.stdioCmd})`,
      )

      setResponseHeaders({ res, headers })

      // Create a fresh Server for each connection
      const connectionServer = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )

      const sseTransport = new SSEServerTransport(
        `${baseUrl}${fullMessagePath}`,
        res,
      )

      await connectionServer.connect(sseTransport)

      const sessionId = sseTransport.sessionId
      if (sessionId) {
        sessions[sessionId] = { transport: sseTransport, response: res }
      }

      sseTransport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(
          `SSE → Child (session ${sessionId}, path ${fullSsePath}): ${JSON.stringify(msg)}`,
        )
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      const cleanup = async () => {
        logger.info(
          `SSE connection closed (session ${sessionId}, path ${fullSsePath})`,
        )
        delete sessions[sessionId]
        await connectionServer.close?.()
      }

      sseTransport.onclose = cleanup
      sseTransport.onerror = async (err) => {
        logger.error(
          `SSE error (session ${sessionId}, path ${fullSsePath}):`,
          err,
        )
        await cleanup()
      }

      req.on('close', async () => {
        logger.info(
          `Client disconnected (session ${sessionId}, path ${fullSsePath})`,
        )
        await cleanup()
      })
    })

    // @ts-ignore
    app.post(fullMessagePath, async (req, res) => {
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
        logger.info(
          `POST to SSE transport (session ${sessionId}, path ${fullMessagePath})`,
        )
        await session.transport.handlePostMessage(req, res)
      } else {
        res
          .status(503)
          .send(`No active SSE connection for session ${sessionId}`)
      }
    })

    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach((line) => {
        if (!line.trim()) return
        try {
          const jsonMsg = JSON.parse(line)
          logger.info(`Child → SSE [${serverConfig.path || '/'}]:`, jsonMsg)
          for (const [sid, session] of Object.entries(sessions)) {
            try {
              session.transport.send(jsonMsg)
            } catch (err) {
              logger.error(
                `Failed to send to session ${sid} [${serverConfig.path || '/'}]:`,
                err,
              )
              delete sessions[sid]
            }
          }
        } catch {
          logger.error(`Child non-JSON [${serverConfig.path || '/'}]: ${line}`)
        }
      })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      logger.error(
        `Child stderr [${serverConfig.path || '/'}]: ${chunk.toString('utf8')}`,
      )
    })

    return {
      child,
      sessions,
      fullSsePath,
      fullMessagePath,
    }
  })

  if (serversState.length === 1 && servers[0]?.path === '/') {
    logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`)
    logger.info(`POST messages: http://localhost:${port}${messagePath}`)
  } else {
    for (const state of serversState) {
      logger.info(`SSE endpoint: http://localhost:${port}${state.fullSsePath}`)
      logger.info(
        `POST messages: http://localhost:${port}${state.fullMessagePath}`,
      )
    }
  }
}
