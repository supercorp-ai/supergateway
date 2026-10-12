import type { Request, Response } from 'express'
import {
  type ReadHeader,
  validateModernHeaders,
  HEADER_MISMATCH,
} from './modernHeaders.js'
import { classifyInboundRequest, isJsonContentType } from './modernSdk.js'

export type Route = Exclude<Awaited<ReturnType<typeof admit>>, boolean>

// The JSON-RPC error codes the relay answers with, or reads a status from.
const SERVER_ERROR = -32000

// A header as one string, however many times it was sent.
export const headerValue =
  (req: Request): ReadHeader =>
  (name) => {
    const header = req.headers[name]
    return Array.isArray(header) ? header.join(', ') : header
  }

// The client's mirrors of a tool call's arguments, as it sent them.
export const paramHeaders = (req: Request) =>
  Object.fromEntries(
    Object.keys(req.headers)
      .filter((name) => name.startsWith('mcp-param-'))
      .map((name) => [name, headerValue(req)(name)!]),
  )

// The id a rejection answers: the request's own, when it has a usable one.
const requestIdOf = (body: unknown) => {
  const id = (body as { id?: unknown } | undefined)?.id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

export const rejectWith = (
  req: Request,
  res: Response,
  status: number,
  error: { code: number; message: string; data?: unknown },
) => {
  res.status(status).json({
    jsonrpc: '2.0',
    id: requestIdOf(req.body),
    error,
  })
}

/**
 * Whether this POST is a modern request this gateway serves. `false` hands it
 * to the legacy path (it is no modern request, or the server speaks none),
 * `true` means it has been answered with a rejection, and a route means serve
 * it.
 */
export async function admit(
  req: Request,
  res: Response,
  value: ReadHeader,
  speaks: () => boolean | Promise<boolean>,
) {
  const reject = (
    status: number,
    error: Parameters<typeof rejectWith>[3],
  ): true => {
    rejectWith(req, res, status, error)
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
  // A server that does not speak it is served as before there was a relay.
  if (!(await speaks())) return false
  if (!isJsonContentType(value('content-type') ?? null))
    return reject(415, {
      code: SERVER_ERROR,
      message: 'Content-Type must be application/json',
    })
  if (route.kind === 'reject')
    return reject(route.httpStatus, {
      code: route.code,
      message: route.message,
      ...(route.data === undefined ? {} : { data: route.data }),
    })
  if (!acceptsBoth(value('accept') ?? ''))
    return reject(406, {
      code: SERVER_ERROR,
      message: 'Client must accept application/json and text/event-stream',
    })
  try {
    validateModernHeaders(route.message, value)
  } catch (error) {
    return reject(400, {
      code: HEADER_MISMATCH,
      message: (error as Error).message,
    })
  }
  return route
}

// A modern reply may be JSON or an SSE stream, so the client must take both.
const acceptsBoth = (accept: string) =>
  accept.includes('application/json') && accept.includes('text/event-stream')
