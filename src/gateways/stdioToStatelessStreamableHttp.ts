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

export interface StdioToStreamableHttpArgs {
  stdioCmd: string
  port: number
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  protocolVersion: string
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

// Helper function to create initialize request
const createInitializeRequest = (
  id: string | number,
  protocolVersion: string,
): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion,
    capabilities: {
      roots: {
        listChanged: true,
      },
      sampling: {},
    },
    clientInfo: {
      name: 'supergateway',
      version: getVersion(),
    },
  },
})

// Helper function to create initialized notification
const createInitializedNotification = (): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
})

export async function stdioToStatelessStreamableHttp(
  args: StdioToStreamableHttpArgs,
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
  } = args

  logger.info(
    `  - Headers: ${Object(headers).length ? JSON.stringify(headers) : '(none)'}`,
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
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  app.post(streamableHttpPath, async (req, res) => {
    // In stateless mode, create a new instance of transport and server for each request
    // to ensure complete isolation. A single instance would cause request ID collisions
    // when multiple clients connect concurrently.

    try {
      const server = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      })

      await server.connect(transport)
      const child = spawn(stdioCmd, { shell: true })
      child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        transport.close()
      })

      // State tracking for initialization flow
      let isInitialized = false
      let initializeRequestId: string | number | null = null // Current initialize request ID
      let isAutoInitializing = false // Flag to indicate if we're auto-initializing
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
            logger.info('Child → StreamableHttp:', line)

            // Handle initialize response (both auto and client initiated)
            if (initializeRequestId && jsonMsg.id === initializeRequestId) {
              logger.info('Initialize response received')
              isInitialized = true

              // If this was our auto-initialization, send initialized notification and pending message
              if (isAutoInitializing) {
                // Send initialized notification
                const initializedNotification = createInitializedNotification()
                logger.info(
                  `StreamableHttp → Child (initialized): ${JSON.stringify(initializedNotification)}`,
                )
                child.stdin.write(
                  JSON.stringify(initializedNotification) + '\n',
                )

                // Now send the original message
                if (pendingOriginalMessage) {
                  logger.info(
                    `StreamableHttp → Child (original): ${JSON.stringify(pendingOriginalMessage)}`,
                  )
                  child.stdin.write(
                    JSON.stringify(pendingOriginalMessage) + '\n',
                  )
                  pendingOriginalMessage = null
                }

                // Reset auto-initialize tracking
                isAutoInitializing = false
                initializeRequestId = null

                // Don't forward our auto-initialize response to the client
                return
              } else {
                // Client-initiated initialize response, just reset tracking
                initializeRequestId = null
              }
            }

            try {
              transport.send(jsonMsg)
            } catch (e) {
              logger.error(`Failed to send to StreamableHttp`, e)
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

        // Check if we need to auto-initialize first
        if (!isInitialized && !isInitializeRequest(msg)) {
          // Store the original message and send initialize first
          pendingOriginalMessage = msg
          initializeRequestId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          isAutoInitializing = true

          logger.info(
            'Non-initialize message detected, sending auto-initialize request first',
          )
          const initRequest = createInitializeRequest(
            initializeRequestId,
            protocolVersion,
          )
          logger.info(
            `StreamableHttp → Child (auto-initialize): ${JSON.stringify(initRequest)}`,
          )
          child.stdin.write(JSON.stringify(initRequest) + '\n')

          // Don't send the original message yet - it will be sent after initialization
          return
        }

        // Track initialize request ID (both client and auto)
        if (isInitializeRequest(msg) && 'id' in msg && msg.id !== undefined) {
          initializeRequestId = msg.id
          isAutoInitializing = false // This is client-initiated
          logger.info(`Tracking initialize request ID: ${msg.id}`)
        }

        // Send all messages to child process normally
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        logger.info('StreamableHttp connection closed')
        child.kill()
      }

      transport.onerror = (err) => {
        logger.error(`StreamableHttp error:`, err)
        child.kill()
      }

      await transport.handleRequest(req, res, req.body)
    } catch (error) {
      logger.error('Error handling MCP request:', error)
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        })
      }
    }
  })

  app.get(streamableHttpPath, async (req, res) => {
    logger.info('Received GET MCP request')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
        id: null,
      }),
    )
  })

  app.delete(streamableHttpPath, async (req, res) => {
    logger.info('Received DELETE MCP request')
    res.writeHead(405).end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32000,
          message: 'Method not allowed.',
        },
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
