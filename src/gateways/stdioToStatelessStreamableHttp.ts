import { spawn } from 'child_process'
import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import { createModernHttp } from '../lib/modernHttp.js'
import { escapeSseJsonSeparators } from '../lib/escapeSseJsonSeparators.js'
import { jsonBodyErrors } from '../lib/jsonBodyErrors.js'
import { endpointHost, listenOn } from '../lib/listenHost.js'
import type { Mount } from '../lib/serve.js'
import { announceGateway } from '../lib/gatewayListing.js'
import { onSignals } from '../lib/onSignals.js'
import { keepConnectionsAlive } from '../lib/keepConnectionsAlive.js'
import { drained } from '../lib/outputBackpressure.js'
import { ChildLink } from '../lib/childHandoff.js'
import { StatelessInitialization } from '../lib/statelessInitialization.js'
import { failPendingCalls } from '../lib/failPendingCalls.js'
import { requireApiKey } from '../lib/apiKey.js'
import { startServer, type ServerSource } from '../lib/serverSource.js'

interface StdioToStreamableHttpOptions {
  port: number
  /** The address to listen on; every interface when unset. */
  host?: string
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  // The keys a client must present; none, or left out, means no check.
  apiKeys?: string[]
  protocolVersion: string
}

/** A server and how it is served over Streamable HTTP. */
export type StdioToStreamableHttpArgs = ServerSource &
  StdioToStreamableHttpOptions

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
  const { port, host, logger } = args
  const mount = stdioToStatelessStreamableHttpMount(args)
  onSignals({ logger, cleanup: mount.close, drainStdin: true })
  keepConnectionsAlive(
    listenOn(mount.app, port, host, () => {
      logger.info(`Listening on port ${port}`)
      mount.listening(host, port)
    }),
  )
}

export function stdioToStatelessStreamableHttpMount(
  args: ServerSource &
    Omit<StdioToStreamableHttpOptions, 'port'> & {
      port?: number
      /** The URL path the server's requests start with; `/` by default. */
      path?: string
    },
): Mount {
  const {
    port,
    host,
    streamableHttpPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    apiKeys = [],
    path = '/',
    protocolVersion,
  } = args

  announceGateway(logger, {
    headers,
    port,
    host,
    source: args,
    settings: [
      `streamableHttpPath: ${streamableHttpPath}`,
      `protocolVersion: ${protocolVersion}`,
    ],
    corsOrigin,
    healthEndpoints,
    apiKeys,
  })

  const children = new OwnedChildProcesses(logger)
  // The 2026-07-28 relay starts a local server per request. A remote one is
  // served over the sessions of the earlier protocol versions only.
  const modern = args.upstream
    ? undefined
    : createModernHttp({ stdioCmd: args.stdioCmd, children, logger })

  const app = express()
  app.use((_req, res, next) => {
    escapeSseJsonSeparators(res)
    // --header applies to every response, as it does in SSE mode. It used to
    // reach only the health endpoint.
    setResponseHeaders({ res, headers })
    next()
  })
  // Same ceiling the SDK applies to SSE messages; express defaults to 100 kB.
  const parseJson = [express.json({ limit: '4mb' }), jsonBodyErrors]
  // Without keys, bodies are read here, as they always were. With keys, not
  // until the request has presented one: an unauthenticated caller must not
  // make the gateway read and parse up to 4 MB, and gets 401, not 400 or 413.
  if (apiKeys.length === 0) app.use(parseJson)

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin }))
  }

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      res.send('ok')
    })
  }

  // After CORS and the health endpoints, which stay open; before POST, GET
  // and DELETE on the path, modern 2026-07-28 requests included.
  app.use(requireApiKey(apiKeys, logger))
  if (apiKeys.length > 0) app.use(parseJson)

  app.post(streamableHttpPath, async (req, res) => {
    if (children.closing) {
      res.status(503).send('Gateway is shutting down')
      return
    }
    if (await modern?.handle(req, res)) return
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
      const peer = startServer(spawn, args, children, logger, 'Request')
      const stop = () => link.stop()
      const pendingRequests = new Set<string | number>()
      let childFailed = false
      let released = false
      let finishTimer: NodeJS.Timeout | undefined
      // Settles once the SDK has dispatched this request, and written any
      // reply of its own (a 400 for a request it refused).
      let dispatched!: () => void
      const handling = new Promise<void>((resolve) => (dispatched = resolve))
      const handleChildFailure = (err?: Error) => {
        // Exit, ChildProcess errors and stdin errors can arrive for the same
        // child. Keep listeners installed and terminate this transport once.
        if (childFailed) return
        childFailed = true
        released = true
        clearTimeout(finishTimer)
        if (err) logger.error('Child process failure:', err)
        void stop()
        const fail = () =>
          failPendingCalls({ transport, pending: pendingRequests, res, logger })
        // With calls pending, answer them now: the SDK's dispatch waits for
        // them. With none, the SDK may still be writing a reply of its own (a
        // 400 for a request it refused), which closing the transport and the
        // response would cut off; a server that ends at once (a remote
        // session, closed as soon as it is stopped) always did.
        if (pendingRequests.size) fail()
        else void handling.then(fail)
      }

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
          initialization.pending
        )
          return
        if (hasOneWayMessage) {
          // HTTP 202 precedes delivery, and notifications have no completion
          // reply. Forward first, then allow stdio EOF a bounded grace period.
          link.peer.end()
          finishTimer = setTimeout(release, 5000)
        } else release()
      }
      res.once('close', () => {
        responseClosed = true
        finishRequest()
      })

      const link = new ChildLink(peer, {
        failure: (_kind, err) => handleChildFailure(err),
        exit: (code, signal) => {
          logger.error(`Child exited: code=${code}, signal=${signal}`)
          // HTTP EOF alone does not settle an SDK request. Use the same
          // idempotent error delivery as spawn/stdin failure before closing.
          handleChildFailure()
        },
        message: (jsonMsg, line) => {
          logger.info('Child → StreamableHttp:', line)
          // A later HTTP POST starts a different child, so it cannot answer
          // this child's reverse request. Reply locally instead of hanging.
          if ('method' in jsonMsg && 'id' in jsonMsg) {
            link.write({
              jsonrpc: '2.0',
              id: jsonMsg.id,
              ...(jsonMsg.method === 'ping'
                ? { result: {} }
                : {
                    error: {
                      code: -32601,
                      message:
                        'Server-to-client requests are not supported in stateless mode',
                    },
                  }),
            })
            return
          }
          if ('id' in jsonMsg) {
            pendingRequests.delete(jsonMsg.id)
          }

          // The answer to the gateway's own initialize is not the client's.
          if (initialization.fromChild(jsonMsg)) return

          void transport
            .send(jsonMsg, {
              // Each stateless child serves one POST. Responses route by
              // their own ID; notifications share the pending request stream.
              relatedRequestId: pendingRequests.values().next().value,
            })
            .catch((e) => {
              logger.error(`Failed to send to StreamableHttp`, e)
            })
            .finally(finishRequest)
        },
        nonJson: (line) => logger.error(`Child non-JSON: ${line}`),
        stderr: (text) => logger.error(`Child stderr: ${text}`),
        output: () => drained([res]),
      })

      const initialization = new StatelessInitialization(
        (message) => link.write(message),
        logger,
        finishRequest,
      )

      transport.onmessage = (msg: JSONRPCMessage) => {
        if ('id' in msg && 'method' in msg) pendingRequests.add(msg.id!)
        else hasOneWayMessage = true
        initialization.fromClient(
          msg,
          (req.headers['mcp-protocol-version'] as string | undefined) ??
            protocolVersion,
        )
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
        dispatched()
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

  return {
    app,
    path,
    listening: (listenHost, listenPort) =>
      logger.info(
        `StreamableHttp endpoint: http://${endpointHost(listenHost)}:${listenPort}${streamableHttpPath}`,
      ),
    close: async () => {
      await Promise.all([modern?.close(), children.close()])
    },
  }
}
