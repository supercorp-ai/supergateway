import { spawn } from 'child_process'
import { StringDecoder } from 'node:string_decoder'
import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { createServer } from 'http'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { WebSocketServerTransport } from '../server/websocket.js'
import { onSignals } from '../lib/onSignals.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

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

  const children = new OwnedChildProcesses(logger)
  const cleanup = () => {
    if (wsTransport) {
      wsTransport.close().catch((err) => {
        logger.error(`Error stopping WebSocket server: ${err.message}`)
      })
    }
    return children.close()
  }

  onSignals({
    logger,
    cleanup,
    drainStdin: true,
  })

  try {
    child = spawn(stdioCmd, children.spawnOptions)
    children.own(child)
    child.on('exit', (code, signal) => {
      logger.error(`Child exited: code=${code}, signal=${signal}`)
      void cleanup().then(() => process.exit(code ?? 1))
    })

    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )

    // Handle child process output
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += decoder.write(chunk)
      const lines = buffer.split(/\r?\n/)
      // `split` always returns at least one element, so `pop()` is never
      // undefined here — the fallback it replaced could not be taken.
      buffer = lines.pop()!
      lines.forEach((line) => {
        if (!line.trim()) return
        try {
          const jsonMsg = JSON.parse(line)
          logger.info(`Child → WebSocket: ${JSON.stringify(jsonMsg)}`)
          // Broadcast to all connected clients
          // `wsTransport` is assigned further down this same synchronous
          // stretch — there is no await between registering this handler and
          // that assignment — so Node cannot deliver a chunk while it is still
          // null. The optional chain guarded a tick that cannot happen.
          wsTransport!.send(jsonMsg, jsonMsg.id).catch((err) => {
            logger.error('Failed to broadcast message:', err)
          })
        } catch {
          logger.error(`Child non-JSON: ${line}`)
        }
      })
    })

    child.stderr.on('data', (chunk: Buffer) => {
      logger.info(`Child stderr: ${chunk.toString('utf8')}`)
    })

    const app = express()

    if (corsOrigin) {
      app.use(cors({ origin: corsOrigin }))
    }

    for (const ep of healthEndpoints) {
      app.get(ep, (_req, res) => {
        // The child is spawned before this route is registered, and the route
        // cannot be reached before the server listens.
        if (child!.killed) {
          res.status(500).send('Child process has been killed')
        }

        if (!isReady) {
          res.status(500).send('Server is not ready')
        }

        res.send('ok')
      })
    }

    // @types/express declares RequestHandler as returning `void | Promise<void>`,
    // and Application extends it, so the rule sees a possibly-async handler.
    // Express 4's app is not one: it is `function (req, res, next) {
    // app.handle(req, res, next) }` — arity 3, returns undefined. Passing it to
    // http.createServer is the documented pattern, so this is a declaration
    // artifact rather than a floating promise.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises
    const httpServer = createServer(app)

    wsTransport = new WebSocketServerTransport({
      path: messagePath,
      server: httpServer,
    })

    await server.connect(wsTransport)

    wsTransport.onmessage = (msg: JSONRPCMessage) => {
      const line = JSON.stringify(msg)
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
    await cleanup()
    process.exit(1)
  }
}
