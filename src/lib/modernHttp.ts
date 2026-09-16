import type { Request, Response } from 'express'
import {
  PerRequestHTTPServerTransport,
  classifyInboundRequest,
  toNodeHandler,
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
      const route = classifyInboundRequest({
        httpMethod: req.method,
        body: req.body,
        protocolVersionHeader: value('mcp-protocol-version'),
        mcpMethodHeader: value('mcp-method'),
        mcpNameHeader: value('mcp-name'),
      })
      if (route.kind === 'legacy') return false
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
      const transport = new PerRequestHTTPServerTransport({
        classification: route.classification,
      })
      const child = new OwnedStdioTransport(stdioCmd, children, logger)
      let stopped = false
      let failed = false
      let stopPromise: Promise<void> | undefined
      const stop = () => {
        if (!stopPromise) {
          stopped = true
          res.off('close', closed)
          stopPromise = Promise.resolve().then(async () => {
            await transport.close()
            await child.close()
            active.delete(stop)
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
        logger.error('MCP child request failed:', error)
        if (route.messageKind === 'request') {
          await transport.send({
            jsonrpc: '2.0',
            id: route.message.id,
            error: { code: -32603, message: 'MCP server process failed' },
          })
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
      transport.onmessage = (message) => {
        void (async () => {
          if (stopped || children.closing)
            throw new Error('Gateway is shutting down')
          await child.start()
          if (stopped) {
            await child.close()
            return
          }
          await child.send(message)
          if (route.messageKind === 'notification') await stop()
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
          fetch: (request) =>
            transport.handleMessage(route.message, { request }),
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
