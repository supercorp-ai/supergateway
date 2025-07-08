import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
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

export interface StdioToStreamableHttpArgs {
  stdioCmd: string
  port: number
  streamableHttpPath: string
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
  } = args

  logger.info(
    `  - Headers: ${Object(headers).length ? safeJsonStringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - streamableHttpPath: ${streamableHttpPath}`)

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

      const jsonBuffer = new JsonBuffer(
        (jsonMsg) => {
          logger.info('Child → StreamableHttp:', safeJsonStringify(jsonMsg))
          try {
            transport.send(sanitizeJsonObject(jsonMsg))
          } catch (e) {
            logger.error(`Failed to send to StreamableHttp`, e)
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

      transport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(`StreamableHttp → Child: ${safeJsonStringify(msg)}`)
        child.stdin.write(safeJsonStringify(msg) + '\n')
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
        res.setHeader('Content-Type', 'application/json')
        res.status(500).end(
          safeJsonStringify({
            jsonrpc: '2.0',
            error: {
              code: -32603,
              message: 'Internal server error',
            },
            id: null,
          }),
        )
      }
    }
  })

  app.get(streamableHttpPath, async (req, res) => {
    logger.info('Received GET MCP request')
    res.writeHead(405).end(
      safeJsonStringify({
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
      safeJsonStringify({
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
