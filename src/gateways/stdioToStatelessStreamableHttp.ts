import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  JSONRPCMessage,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

export interface StdioToStatelessStreamableHttpArgs {
  stdioCmd: string
  port: number
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  protocolVersion: string
  headersPassthrough: string[]
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

const createInitializeRequest = (
  id: string | number,
  protocolVersion: string,
): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion,
    capabilities: { roots: { listChanged: true }, sampling: {} },
    clientInfo: { name: 'supergateway', version: getVersion() },
  },
})

const createInitializedNotification = (): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
})

export async function stdioToStatelessStreamableHttp(
  args: StdioToStatelessStreamableHttpArgs,
) {
  const {
    stdioCmd,
    port,
    streamableHttpPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    protocolVersion,
    headersPassthrough,
  } = args

  logger.info(
    `  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - streamableHttpPath: ${streamableHttpPath}`)
  logger.info(`  - protocolVersion: ${protocolVersion}`)
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  const app = express()
  app.use(express.json())

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({ res, headers })
      res.send('ok')
    })
  }

  app.post(streamableHttpPath, async (req, res) => {
    try {
      const server = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      await server.connect(transport)

      const passthroughEnv: Record<string, string> = {}
      for (const headerName of headersPassthrough) {
        const value = req.headers[headerName.toLowerCase()]
        if (value !== undefined) {
          const envKey = `HEADER_${headerName.toUpperCase().replace(/-/g, '_')}`
          passthroughEnv[envKey] = Array.isArray(value)
            ? value.join(', ')
            : value
        }
      }

      const child = spawn(stdioCmd, {
        shell: true,
        env: { ...process.env, ...passthroughEnv },
      })
      child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        transport.close()
      })

      let isInitialized = false
      let initializeRequestId: string | number | null = null
      let isAutoInitializing = false
      let pendingOriginalMessage: JSONRPCMessage | null = null

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        lines.forEach((line) => {
          if (!line.trim()) return
          try {
            const jsonMsg = JSON.parse(line)
            logger.info(`Child → StreamableHttp: ${line}`)

            if (
              initializeRequestId !== null &&
              jsonMsg.id === initializeRequestId
            ) {
              logger.info('Initialize response received')
              isInitialized = true

              if (isAutoInitializing) {
                const notification = createInitializedNotification()
                logger.info(
                  `StreamableHttp → Child (initialized): ${JSON.stringify(notification)}`,
                )
                child.stdin.write(JSON.stringify(notification) + '\n')

                if (pendingOriginalMessage) {
                  logger.info(
                    `StreamableHttp → Child (original): ${JSON.stringify(pendingOriginalMessage)}`,
                  )
                  child.stdin.write(
                    JSON.stringify(pendingOriginalMessage) + '\n',
                  )
                  pendingOriginalMessage = null
                }

                isAutoInitializing = false
                initializeRequestId = null
                return
              } else {
                initializeRequestId = null
              }
            }

            try {
              transport.send(jsonMsg)
            } catch (e) {
              logger.error('Failed to send to StreamableHttp', e)
            }
          } catch {
            logger.error(`Child non-JSON: ${line}`)
          }
        })
      })

      child.stderr.on('data', (chunk: Buffer) => {
        logger.error(`Child stderr: ${chunk.toString('utf8')}`)
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)

        if (!isInitialized && !isInitializeRequest(msg)) {
          pendingOriginalMessage = msg
          initializeRequestId = `init_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
          isAutoInitializing = true

          logger.info(
            'Non-initialize message detected, auto-initializing first',
          )
          const initRequest = createInitializeRequest(
            initializeRequestId,
            protocolVersion,
          )
          logger.info(
            `StreamableHttp → Child (auto-initialize): ${JSON.stringify(initRequest)}`,
          )
          child.stdin.write(JSON.stringify(initRequest) + '\n')
          return
        }

        if (isInitializeRequest(msg) && 'id' in msg && msg.id !== undefined) {
          initializeRequestId = msg.id
          isAutoInitializing = false
          logger.info(`Tracking initialize request ID: ${msg.id}`)
        }

        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        logger.info('StreamableHttp connection closed')
        child.kill()
      }

      transport.onerror = (err: Error) => {
        logger.error('StreamableHttp error:', err)
        child.kill()
      }

      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      logger.error('Error handling MCP request:', error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        })
      }
    }
  })

  app.get(streamableHttpPath, (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    )
  })

  app.delete(streamableHttpPath, (_req, res) => {
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed.' },
        id: null,
      }),
    )
  })

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(
      `StreamableHttp endpoint: http://localhost:${port}${streamableHttpPath}`,
    )
  })
}
