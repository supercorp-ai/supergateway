import { spawn } from 'child_process'
import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  JSONRPCMessage,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'
import { describeHeaders } from '../lib/headers.js'

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

  logger.info(`  - Headers: ${describeHeaders(headers)}`)
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

  const children = new OwnedChildProcesses(logger)
  onSignals({ logger, cleanup: () => children.close(), drainStdin: true })

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
    if (children.closing) {
      res.status(503).send('Gateway is shutting down')
      return
    }
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
      const child = spawn(stdioCmd, children.spawnOptions)
      const stop = children.own(child)
      const pendingRequests = new Set<string | number>()
      let childFailed = false
      let released = false
      let finishTimer: NodeJS.Timeout | undefined
      const handleChildFailure = (err?: Error) => {
        // Exit, ChildProcess errors and stdin errors can arrive for the same
        // child. Keep listeners installed and terminate this transport once.
        if (childFailed) return
        childFailed = true
        released = true
        clearTimeout(finishTimer)
        if (err) logger.error('Child process failure:', err)
        void stop()
        // Ending an SSE response alone leaves SDK clients waiting for their
        // request timeout. Fail each outstanding call before closing streams.
        const replies = [...pendingRequests].map((id) =>
          transport
            .send({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: 'MCP server process failed' },
            })
            .catch((sendError) => {
              logger.error('Failed to send child failure', sendError)
            }),
        )
        pendingRequests.clear()
        void Promise.all(replies)
          .then(() => transport.close())
          .catch((closeError) => {
            logger.error(
              'Failed to close transport after child failure',
              closeError,
            )
          })
          .finally(() => {
            // A spawn failure can precede SDK response registration. Do not
            // destroy a completed response: its error frame must flush first.
            if (!res.writableEnded) res.destroy()
          })
      }
      child.on('error', handleChildFailure)
      child.stdin.on('error', handleChildFailure)
      child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        // HTTP EOF alone does not settle an SDK request. Use the same
        // idempotent error delivery as spawn/stdin failure before closing.
        handleChildFailure()
      })

      // State tracking for initialization flow
      let initializeRequestId: string | number | null = null // Current initialize request ID
      let isAutoInitializing = false // Flag to indicate if we're auto-initializing
      let pendingOriginalMessage: JSONRPCMessage | null = null
      let responseClosed = false
      let handled = false
      let hasOneWayMessage = false
      const release = () => {
        if (released) return
        released = true
        void stop()
        server.close().catch((error) => {
          logger.error('Failed to close completed stateless request', error)
        })
      }
      const finishRequest = () => {
        // handleRequest resolves after dispatch, not after the child replies.
        // A disconnected HTTP client also does not cancel its in-flight work.
        if (
          released ||
          finishTimer ||
          !handled ||
          !responseClosed ||
          pendingRequests.size ||
          isAutoInitializing
        )
          return
        if (hasOneWayMessage) {
          // HTTP 202 precedes delivery, and notifications have no completion
          // reply. Forward first, then allow stdio EOF a bounded grace period.
          child.stdin.end()
          finishTimer = setTimeout(release, 5000)
        } else release()
      }
      res.once('close', () => {
        responseClosed = true
        finishRequest()
      })

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        // `split` always returns at least one element, so `pop()` is never
        // undefined here — the fallback it replaced could not be taken.
        buffer = lines.pop()!
        lines.forEach((line) => {
          if (!line.trim()) return
          try {
            const jsonMsg = JSON.parse(line)
            logger.info('Child → StreamableHttp:', line)
            if ('id' in jsonMsg && !('method' in jsonMsg)) {
              pendingRequests.delete(jsonMsg.id)
            }

            // Handle initialize response (both auto and client initiated)
            if (initializeRequestId && jsonMsg.id === initializeRequestId) {
              logger.info('Initialize response received')

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

                // Now send the original message. There is always one to
                // send: `isAutoInitializing` is only ever set true alongside
                // assigning it, and the only assignment back to null is the one
                // below, immediately before the flag is cleared again. The
                // guard that used to stand here could not be false.
                logger.info(
                  `StreamableHttp → Child (original): ${JSON.stringify(pendingOriginalMessage)}`,
                )
                child.stdin.write(JSON.stringify(pendingOriginalMessage) + '\n')
                pendingOriginalMessage = null

                // Reset auto-initialize tracking
                isAutoInitializing = false
                initializeRequestId = null
                finishRequest()

                // Don't forward our auto-initialize response to the client
                return
              } else {
                // Client-initiated initialize response, just reset tracking
                initializeRequestId = null
              }
            }

            void transport
              .send(jsonMsg)
              .catch((e) => {
                logger.error(`Failed to send to StreamableHttp`, e)
              })
              .finally(finishRequest)
          } catch {
            logger.error(`Child non-JSON: ${line}`)
          }
        })
      })

      child.stderr.on('data', (chunk: Buffer) => {
        logger.error(`Child stderr: ${chunk.toString('utf8')}`)
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        if ('id' in msg && 'method' in msg) pendingRequests.add(msg.id!)
        else hasOneWayMessage = true
        logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)

        // Auto-initialize anything that is not itself an initialize request.
        //
        // This used to also test an `isInitialized` flag, which could never be
        // true here. Stateless spawns a child per POST and declares its state
        // inside the request handler, so nothing has handshaken when a message
        // arrives; the flag was set from the child's stdout handler, which
        // cannot run before this one returns, because the SDK dispatches a
        // POST's messages in a synchronous `for` loop with no await between
        // iterations. The condition was dead, and the flag write-only with it.
        if (!isInitializeRequest(msg)) {
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

        // Only an initialize request reaches this line — everything else
        // returned above — so the predicate that used to lead this condition is
        // implied by control flow now.
        //
        // The id still has to be looked for: `isInitializeRequest` accepts a
        // notification-shaped initialize, because the SDK's schema requires
        // only `method` and `params`. Presence is the whole test. Every version
        // in the support matrix (1.18.2 through 1.30.0) parses a request with a
        // strict schema whose `id` is `union([string, number.int()])` and a
        // notification with a strict schema carrying no `id` key, so a present
        // `id` is never `undefined`.
        //
        // The assertion is for the compiler, not the value. `msg` is the
        // message union, and narrowing it with `in` leaves the
        // notification-shaped member in the type with `id?: undefined` bolted
        // on — from SDK 1.25.3 the declared type is therefore
        // `string | number | undefined`, though the runtime check has already
        // excluded exactly that member.
        if ('id' in msg) {
          initializeRequestId = msg.id!
          isAutoInitializing = false // This is client-initiated
          logger.info(`Tracking initialize request ID: ${msg.id}`)
        }

        // Send all messages to child process normally
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        logger.info('StreamableHttp connection closed')
        void stop()
      }

      transport.onerror = (err) => {
        logger.error(`StreamableHttp error:`, err)
        void stop()
      }

      try {
        await transport.handleRequest(req, res, req.body)
      } catch (error) {
        release()
        throw error
      } finally {
        handled = true
        finishRequest()
      }
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
