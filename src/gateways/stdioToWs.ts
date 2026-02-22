import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { createServer } from 'http'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger, MultiStdioServerConfig } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { WebSocketServerTransport } from '../server/websocket.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

export interface StdioToWsArgs {
  stdioCmd: string
  port: number
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
}

export interface MultiStdioToWsArgs {
  servers: MultiStdioServerConfig[]
  port: number
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
}

const joinPath = (base: string, suffix: string) => {
  const normalizedBase = base === '/' ? '' : base.replace(/\/$/, '')
  const normalizedSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`
  return `${normalizedBase}${normalizedSuffix}` || '/'
}

export async function stdioToWs(args: StdioToWsArgs, app: express.Express) {
  const { stdioCmd, ...rest } = args

  return multiStdioToWs(
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

export async function multiStdioToWs(
  args: MultiStdioToWsArgs,
  app: express.Express,
) {
  const { servers, port, messagePath, logger, healthEndpoints, corsOrigin } =
    args
  logger.info(`  - port: ${port}`)
  if (servers.length === 1 && servers[0]?.path === '/') {
    logger.info(`  - stdio: ${servers[0].stdioCmd}`)
    logger.info(`  - messagePath: ${messagePath}`)
  } else {
    logger.info('  - multi-server mappings:')
    for (const server of servers) {
      const fullMessagePath = joinPath(server.path || '/', messagePath)
      logger.info(`    WS: ${fullMessagePath} -> ${server.stdioCmd}`)
    }
  }
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  const children: ChildProcessWithoutNullStreams[] = []
  const transports: WebSocketServerTransport[] = []
  let isReady = false

  const cleanup = () => {
    for (const transport of transports) {
      transport
        .close()
        .catch((err) => {
          logger.error(`Error stopping WebSocket server: ${err.message}`)
        })
        .catch(() => {})
    }
    for (const child of children) {
      child.kill()
    }
  }

  onSignals({
    logger,
    cleanup,
  })

  try {
    if (corsOrigin) {
      app.use(cors({ origin: corsOrigin }))
    }

    for (const ep of healthEndpoints) {
      app.get(ep, (_req, res) => {
        const hasDeadChild = children.some((child) => child.killed)

        if (hasDeadChild) {
          res.status(500).send('Child process has been killed')
          return
        }

        if (!isReady) {
          res.status(500).send('Server is not ready')
          return
        }

        res.send('ok')
      })
    }

    const httpServer = createServer(app)

    for (const serverConfig of servers) {
      const child = spawn(serverConfig.stdioCmd, { shell: true })
      children.push(child)

      child.on('exit', (code, signal) => {
        logger.error(
          `Child exited for ${serverConfig.path || '/'}: code=${code}, signal=${signal}`,
        )
      })

      const server = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )

      // Handle child process output
      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        lines.forEach((line) => {
          if (!line.trim()) return
          try {
            const jsonMsg = JSON.parse(line)
            logger.info(
              `Child → WebSocket [${serverConfig.path || '/'}]: ${JSON.stringify(jsonMsg)}`,
            )
            // Broadcast to all connected clients for this path
            const fullMessagePath = joinPath(
              serverConfig.path || '/',
              messagePath,
            )
            const transport = transports.find((t) => t.path === fullMessagePath)
            transport?.send(jsonMsg, jsonMsg.id).catch((err) => {
              logger.error('Failed to broadcast message:', err)
            })
          } catch {
            logger.error(
              `Child non-JSON [${serverConfig.path || '/'}]: ${line}`,
            )
          }
        })
      })

      child.stderr.on('data', (chunk: Buffer) => {
        logger.info(
          `Child stderr [${serverConfig.path || '/'}]: ${chunk.toString('utf8')}`,
        )
      })

      const fullMessagePath = joinPath(serverConfig.path || '/', messagePath)

      const wsTransport = new WebSocketServerTransport({
        path: fullMessagePath,
        server: httpServer,
      })
      transports.push(wsTransport)

      await server.connect(wsTransport)

      wsTransport.onmessage = (msg: JSONRPCMessage) => {
        const line = JSON.stringify(msg)
        logger.info(`WebSocket → Child [${serverConfig.path || '/'}]: ${line}`)
        child.stdin.write(line + '\n')
      }

      wsTransport.onconnection = (clientId: string) => {
        logger.info(
          `New WebSocket connection on ${fullMessagePath}: ${clientId}`,
        )
      }

      wsTransport.ondisconnection = (clientId: string) => {
        logger.info(
          `WebSocket connection closed on ${fullMessagePath}: ${clientId}`,
        )
      }

      wsTransport.onerror = (err: Error) => {
        logger.error(`WebSocket error on ${fullMessagePath}: ${err.message}`)
      }
    }

    isReady = true

    httpServer.listen(port, () => {
      logger.info(`Listening on port ${port}`)
      if (servers.length === 1 && servers[0]?.path === '/') {
        logger.info(`WebSocket endpoint: ws://localhost:${port}${messagePath}`)
      } else {
        for (const serverConfig of servers) {
          const fullMessagePath = joinPath(
            serverConfig.path || '/',
            messagePath,
          )
          logger.info(
            `WebSocket endpoint: ws://localhost:${port}${fullMessagePath}`,
          )
        }
      }
    })
  } catch (err: any) {
    logger.error(`Failed to start: ${err.message}`)
    cleanup()
    process.exit(1)
  }
}
