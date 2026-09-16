import { AsyncLocalStorage } from 'node:async_hooks'
import type { Request, Response } from 'express'
import {
  Client,
  type McpRequest,
  type RequestMethod,
  type ResultTypeMap,
} from './modernSdk.js'
import { z } from 'zod'
import {
  McpServer,
  ProtocolError,
  createMcpHandler,
  fromJsonSchema,
  classifyInboundRequest,
  type ServerCapabilities,
  type ServerContext,
  type CallToolResult,
} from './modernSdk.js'
import { toNodeHandler } from './modernSdk.js'
import type { Logger } from '../types.js'
import { getVersion } from './getVersion.js'
import type { OwnedChildProcesses } from './ownedChildProcesses.js'
import { OwnedStdioTransport } from './ownedStdioTransport.js'

export function createModernHttp(args: {
  stdioCmd: string
  children: OwnedChildProcesses
  logger: Logger
}) {
  const { stdioCmd, children, logger } = args
  const requests = new AsyncLocalStorage<AbortSignal>()
  const handler = createMcpHandler(
    async () => {
      const backend = new Client(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )
      const signal = requests.getStore()!
      const release = () => {
        signal.removeEventListener('abort', abort)
        return backend.close()
      }
      const abort = () => {
        void release()
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        signal.throwIfAborted()
        if (children.closing) throw new Error('Gateway is shutting down')
        await backend.connect(
          new OwnedStdioTransport(stdioCmd, children, logger),
          { signal },
        )
        const advertised = backend.getServerCapabilities()!
        // Per-request children cannot maintain subscriptions or receive a later
        // response to a reverse request. Never promise those capabilities.
        const capabilities: ServerCapabilities = {}
        if (advertised.tools) capabilities.tools = { listChanged: false }
        if (advertised.resources)
          capabilities.resources = { listChanged: false, subscribe: false }
        if (advertised.prompts) capabilities.prompts = { listChanged: false }
        if (advertised.completions) capabilities.completions = {}
        const server = new McpServer(backend.getServerVersion()!, {
          capabilities,
          instructions: backend.getInstructions(),
        })
        server.server.onclose = () => {
          void release()
        }
        server.server.onerror = (error) =>
          logger.error('Modern HTTP error:', error)
        const call = async <T>(action: () => Promise<T>): Promise<T> => {
          try {
            return await action()
          } catch (error) {
            if (error instanceof ProtocolError) throw error
            logger.error('MCP request failed:', error)
            throw new ProtocolError(-32603, 'MCP server process failed')
          }
        }
        const forward = <M extends RequestMethod>(
          request: { method: M; params?: Record<string, unknown> },
          ctx: ServerContext,
        ): Promise<ResultTypeMap[M]> =>
          call(() =>
            backend.request(
              {
                ...request,
                params: { ...request.params, _meta: ctx.mcpReq._meta },
              },
              {
                signal: ctx.mcpReq.signal,
                ...(ctx.mcpReq._meta?.progressToken !== undefined
                  ? {
                      onprogress: (progress) => {
                        void ctx.mcpReq
                          .notify({
                            method: 'notifications/progress',
                            params: {
                              ...progress,
                              progressToken: ctx.mcpReq._meta!.progressToken!,
                            },
                          })
                          .catch((error) =>
                            logger.error('Failed to forward progress:', error),
                          )
                      },
                    }
                  : {}),
              },
            ),
          )
        if (advertised.tools) {
          let cursor: string | undefined
          const cursors = new Set<string>()
          do {
            const page = await backend.request(
              { method: 'tools/list', params: { cursor } },
              { signal },
            )
            for (const tool of page.tools) {
              server.registerTool(
                tool.name,
                {
                  title: tool.title,
                  icons: tool.icons,
                  description: tool.description,
                  inputSchema: fromJsonSchema(
                    tool.inputSchema as Parameters<typeof fromJsonSchema>[0],
                  ),
                  ...(tool.outputSchema
                    ? {
                        outputSchema: fromJsonSchema(
                          tool.outputSchema as Parameters<
                            typeof fromJsonSchema
                          >[0],
                        ),
                      }
                    : {}),
                  annotations: tool.annotations,
                  _meta: tool._meta,
                },
                async (input, ctx) => {
                  return (await forward(
                    {
                      method: 'tools/call',
                      params: { name: tool.name, arguments: input },
                    },
                    ctx,
                  )) as CallToolResult
                },
              )
            }
            cursor = page.nextCursor
            if (cursor !== undefined) {
              if (cursors.has(cursor))
                throw new Error('MCP server repeated a tools cursor')
              cursors.add(cursor)
            }
          } while (cursor !== undefined)
        }
        // registerTool enables change notifications by default; these children
        // last only for this exchange, so retain the narrower advertisement.
        server.server.registerCapabilities(capabilities)
        if (advertised.resources) {
          server.server.setRequestHandler('resources/list', (request, ctx) =>
            forward(request, ctx),
          )
          server.server.setRequestHandler(
            'resources/templates/list',
            (request, ctx) => forward(request, ctx),
          )
          server.server.setRequestHandler('resources/read', (request, ctx) =>
            forward(request, ctx),
          )
        }
        if (advertised.prompts) {
          server.server.setRequestHandler('prompts/list', (request, ctx) =>
            forward(request, ctx),
          )
          server.server.setRequestHandler('prompts/get', (request, ctx) =>
            forward(request, ctx),
          )
        }
        if (advertised.completions) {
          server.server.setRequestHandler(
            'completion/complete',
            (request, ctx) => forward(request, ctx),
          )
        }
        server.server.fallbackRequestHandler = (request, ctx) =>
          call(() =>
            backend.request(request as McpRequest, z.object({}).passthrough(), {
              signal: ctx.mcpReq.signal,
            }),
          )
        return server
      } catch (error) {
        await release()
        throw error
      }
    },
    {
      legacy: 'reject',
      onerror: (error) => logger.error('Modern HTTP error:', error),
    },
  )
  const handle = toNodeHandler(handler, {
    onerror: (error) => logger.error('Modern HTTP adapter error:', error),
  })
  return {
    close: () => handler.close(),
    async handle(req: Request, res: Response): Promise<boolean> {
      const value = (name: string) => {
        const header = req.headers[name]
        return Array.isArray(header) ? header.join(', ') : header
      }
      const route = classifyInboundRequest({
        httpMethod: 'POST',
        body: req.body,
        protocolVersionHeader: value('mcp-protocol-version'),
        mcpMethodHeader: value('mcp-method'),
        mcpNameHeader: value('mcp-name'),
      })
      if (route.kind === 'legacy') return false
      // Node 18 can lose Request-to-parent signal linkage after GC. Bind
      // child ownership directly to this HTTP response instead.
      const controller = new AbortController()
      const closed = () => {
        if (!res.writableFinished) controller.abort()
      }
      res.once('close', closed)
      if (res.destroyed) controller.abort()
      try {
        await requests.run(controller.signal, () => handle(req, res, req.body))
      } finally {
        res.off('close', closed)
      }
      return true
    },
  }
}
