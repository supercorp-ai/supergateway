import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { WebSocketServerTransport } from '../server/websocket.js'
import { createServer } from 'node:http'
import {
  safeJsonStringify,
  safeJsonParse,
  JsonBuffer,
  sanitizeJsonObject,
} from '../lib/jsonBuffer.js'

export interface StdioToWsArgs {
  stdioCmd: string
  port: number
  messagePath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
}

export async function stdioToWs(args: StdioToWsArgs) {
  const { stdioCmd, port, messagePath, logger, healthEndpoints, corsOrigin } =
    args
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - messagePath: ${messagePath}`)
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  let wsTransport: WebSocketServerTransport | null = null
  let child: ChildProcessWithoutNullStreams | null = null
  let isReady = false

  const cleanup = () => {
    if (wsTransport) {
      wsTransport.close().catch((err) => {
        logger.error(`Error stopping WebSocket server: ${err.message}`)
      })
    }
    if (child) {
      child.kill()
    }
  }

  onSignals({
    logger,
    cleanup,
  })

  try {
    child = spawn(stdioCmd, { shell: true })
    child.on('exit', (code, signal) => {
      logger.error(`Child exited: code=${code}, signal=${signal}`)
      cleanup()
      process.exit(code ?? 1)
    })

    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )

    // Handle child process output
    const jsonBuffer = new JsonBuffer(
      (jsonMsg) => {
        logger.info(`Child → WebSocket: ${safeJsonStringify(jsonMsg)}`)
        // Broadcast to all connected clients
        wsTransport
          ?.send(sanitizeJsonObject(jsonMsg), jsonMsg.id)
          .catch((err) => {
            logger.error('Failed to broadcast message:', err)
          })
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
      logger.info(`Child stderr: ${chunk.toString('utf8')}`)
    })

    child.on('close', () => {
      jsonBuffer.flush()
    })

    const app = express()

    if (corsOrigin) {
      app.use(cors({ origin: corsOrigin }))
    }

    for (const ep of healthEndpoints) {
      app.get(ep, (_req, res) => {
        if (child?.killed) {
          res.status(500).send('Child process has been killed')
        }

        if (!isReady) {
          res.status(500).send('Server is not ready')
        }

        res.send('ok')
      })
    }

    const httpServer = createServer(app)

    wsTransport = new WebSocketServerTransport({
      path: messagePath,
      server: httpServer,
    })

    await server.connect(wsTransport)

    wsTransport.onmessage = (msg: JSONRPCMessage) => {
      const line = safeJsonStringify(msg)
      logger.info(`WebSocket → Child: ${line}`)
      child!.stdin.write(line + '\n')
    }

    wsTransport.onconnection = (clientId: string) => {
      logger.info(`New WebSocket connection: ${clientId}`)
    }

    wsTransport.ondisconnection = (clientId: string) => {
      logger.info(`WebSocket connection closed: ${clientId}`)
    }

    wsTransport.onerror = (err: Error) => {
      logger.error(`WebSocket error: ${err.message}`)
    }

    isReady = true

    httpServer.listen(port, () => {
      logger.info(`Listening on port ${port}`)
      logger.info(`WebSocket endpoint: ws://localhost:${port}${messagePath}`)
    })
  } catch (err: any) {
    logger.error(`Failed to start: ${err.message}`)
    cleanup()
    process.exit(1)
  }
}
