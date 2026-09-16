import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import {
  HeaderMismatch,
  validateModernHeaders,
  validateToolHeaders,
  findToolSchema,
} from './modernHeaders.js'
import {
  PerRequestHTTPServerTransport,
  classifyInboundRequest,
  toNodeHandler,
  isJsonContentType,
  type JSONRPCResponse,
} from './modernSdk.js'
import type { Logger } from '../types.js'
import type { OwnedChildProcesses } from './ownedChildProcesses.js'
import { OwnedStdioTransport } from './ownedStdioTransport.js'

export function createModernHttp(args: {
  stdioCmd: string
  children: OwnedChildProcesses
  logger: Logger
}) {
  const { stdioCmd, children, logger } = args
  const active = new Set<() => Promise<void>>()
  return {
    async close() {
      await Promise.all([...active].map((stop) => stop()))
    },
    async handle(req: Request, res: Response): Promise<boolean> {
      const value = (name: string) => {
        const header = req.headers[name]
        return Array.isArray(header) ? header.join(', ') : header
      }
      const reject = (status: number, code: number, message: string) => {
        res.status(status).json({
          jsonrpc: '2.0',
          id:
            typeof req.body?.id === 'string' || typeof req.body?.id === 'number'
              ? req.body.id
              : null,
          error: { code, message },
        })
        return true
      }
      const route = classifyInboundRequest({
        httpMethod: req.method,
        body: req.body,
        protocolVersionHeader: value('mcp-protocol-version'),
        mcpMethodHeader: value('mcp-method'),
        mcpNameHeader: value('mcp-name'),
      })
      if (route.kind === 'legacy') return false
      if (!isJsonContentType(value('content-type') ?? null))
        return reject(415, -32000, 'Content-Type must be application/json')
      if (route.kind === 'reject') {
        res.status(route.httpStatus).json({
          jsonrpc: '2.0',
          id:
            typeof req.body?.id === 'string' || typeof req.body?.id === 'number'
              ? req.body.id
              : null,
          error: {
            code: route.code,
            message: route.message,
            ...(route.data === undefined ? {} : { data: route.data }),
          },
        })
        return true
      }
      const accept = value('accept') ?? ''
      if (
        !accept.includes('application/json') ||
        !accept.includes('text/event-stream')
      )
        return reject(
          406,
          -32000,
          'Client must accept application/json and text/event-stream',
        )
      try {
        validateModernHeaders(route.message, value)
      } catch (error) {
        return reject(400, -32020, (error as Error).message)
      }
      const transport = new PerRequestHTTPServerTransport({
        classification: route.classification,
      })
      const child = new OwnedStdioTransport(stdioCmd, children, logger)
      let pending:
        | {
            id: string
            resolve: (message: JSONRPCResponse) => void
            reject: (error: Error) => void
          }
        | undefined
      let responseStatus = 200
      let dispatched: Promise<void> | undefined
      let stopped = false
      let failed = false
      let stopPromise: Promise<void> | undefined
      const stop = () => {
        if (!stopPromise) {
          stopped = true
          res.off('close', closed)
          pending?.reject(new Error('Request closed'))
          pending = undefined
          stopPromise = Promise.resolve()
            .then(async () => {
              try {
                await transport.close()
              } finally {
                try {
                  await child.close()
                } finally {
                  active.delete(stop)
                }
              }
            })
            .catch((error) => {
              logger.error('Modern request cleanup failed:', error)
            })
        }
        return stopPromise
      }
      const closed = () => {
        void stop()
      }
      const fail = async (error: Error) => {
        if (stopped || failed) return
        failed = true
        pending?.reject(error)
        pending = undefined
        logger.error('MCP child request failed:', error)
        if (error instanceof HeaderMismatch) responseStatus = 400
        if (route.messageKind === 'request') {
          await transport
            .send({
              jsonrpc: '2.0',
              id: route.message.id,
              error:
                error instanceof HeaderMismatch
                  ? { code: error.code, message: error.message }
                  : { code: -32603, message: 'MCP server process failed' },
            })
            .catch((error) => logger.error('Failed to send MCP error:', error))
        }
        await stop()
      }
      child.onerror = (error) => {
        void fail(error)
      }
      child.onclose = () => {
        void fail(new Error('Child stdout closed'))
      }
      child.onmessage = (message) => {
        if (stopped) return
        if ('method' in message && 'id' in message) {
          void fail(
            new Error('Unexpected server request on a modern connection'),
          )
          return
        }
        if (pending) {
          if ('id' in message && message.id === pending.id) {
            const resolve = pending.resolve
            pending = undefined
            resolve(message)
          }
          return
        }
        if (
          'error' in message &&
          route.messageKind === 'request' &&
          message.id === route.message.id
        ) {
          responseStatus =
            message.error.code === -32601
              ? 404
              : [-32020, -32021, -32022].includes(message.error.code)
                ? 400
                : 200
        }
        // Preserve discovery, opaque continuation state, errors and extensions.
        // No protocol Client/Server is inserted to renegotiate or rewrite them.
        void transport
          .send(message, {
            relatedRequestId:
              route.messageKind === 'request' ? route.message.id : undefined,
          })
          .catch(fail)
      }
      transport.onerror = (error) =>
        logger.error('Modern HTTP transport error:', error)
      transport.onclose = () => {
        void stop()
      }
      transport.onmessage = () => {
        const message = route.message
        dispatched = (async () => {
          if (stopped || children.closing)
            throw new Error('Gateway is shutting down')
          await child.start()
          if (stopped) {
            await child.close()
            return
          }
          if (
            route.messageKind === 'request' &&
            message.method === 'tools/call'
          ) {
            // Modern request envelopes are checked by the SDK classifier.
            const params = message.params!
            const schema = await findToolSchema(params.name, async (cursor) => {
              if (stopped) throw new Error('Request closed')
              const id = randomUUID()
              let rejectReply!: (error: Error) => void
              const reply = new Promise<JSONRPCResponse>((resolve, reject) => {
                rejectReply = reject
                pending = { id, resolve, reject }
              })
              const meta: Record<string, unknown> = {
                ...params._meta,
              }
              delete meta.progressToken
              void child
                .send({
                  jsonrpc: '2.0',
                  id,
                  method: 'tools/list',
                  params: {
                    _meta: meta,
                    ...(cursor === undefined ? {} : { cursor }),
                  },
                })
                .catch(rejectReply)
              const result = await reply
              if ('error' in result)
                throw new Error(`tools/list failed: ${result.error.message}`)
              return result.result
            })
            validateToolHeaders(schema, params.arguments, value)
          }
          if (stopped) return
          await child.send(message)
          if (route.messageKind === 'notification') await child.finish()
        })().catch(fail)
      }
      active.add(stop)
      // Node18 can lose a derived Web Request's AbortSignal linkage after GC.
      res.once('close', closed)
      if (res.destroyed) {
        await stop()
        return true
      }
      await transport.start()
      const handle = toNodeHandler(
        {
          fetch: async (request) => {
            const response = await transport.handleMessage(route.message, {
              request,
            })
            if (route.messageKind === 'notification') {
              await dispatched
              if (failed)
                return globalThis.Response.json(
                  {
                    jsonrpc: '2.0',
                    id: null,
                    error: {
                      code: -32603,
                      message: 'MCP server process failed',
                    },
                  },
                  { status: 500 },
                )
            }
            // Once SSE headers are sent, errors must remain on that stream.
            return response.headers.get('content-type') ===
              'application/json' && responseStatus !== response.status
              ? new globalThis.Response(response.body, {
                  status: responseStatus,
                  headers: response.headers,
                })
              : response
          },
        },
        {
          onerror: (error) => logger.error('Modern HTTP adapter error:', error),
        },
      )
      try {
        await handle(req, res, req.body)
      } finally {
        await stop()
      }
      return true
    },
  }
}
