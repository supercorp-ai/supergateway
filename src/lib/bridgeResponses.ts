import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'

// The replies the bridges (--sse, --streamableHttp) write to stdout for a
// request they forwarded upstream. Both used to build them with the same
// logic, copied.

const respond = (req: JSONRPCRequest, payload: object) => ({
  jsonrpc: '2.0' as const,
  id: req.id,
  ...payload,
})

/**
 * The reply carrying what the upstream server returned. `request` throws on a
 * protocol error, so anything it returns is a successful result — including
 * one that happens to carry a field named `error`, which is application data
 * and not a JSON-RPC error.
 */
export const resultResponse = (req: JSONRPCRequest, result: object) =>
  respond(req, { result: { ...result } })

/**
 * The JSON-RPC error reply for a request whose forwarding failed, whatever was
 * thrown. GW-007: an error with a malformed `message` or `code` used to throw
 * inside the error handler itself; any value now yields a well-formed reply,
 * and the thrown value is never modified.
 */
export function errorResponse(req: JSONRPCRequest, err: unknown) {
  const fields =
    err !== null && typeof err === 'object'
      ? (err as { code?: unknown; message?: unknown; data?: unknown })
      : {}
  const rawCode = fields.code
  // JSON-RPC reserves -32768..-32000 for protocol errors, and every code the
  // SDK's McpError uses falls inside it. A transport error carries something
  // else entirely: from SDK 1.24 a failed POST throws StreamableHTTPError whose
  // `code` is the HTTP status, and forwarding that verbatim put `code: 503` on
  // the wire, which no JSON-RPC client can interpret. Such a status belongs in
  // the message, where it is diagnostic rather than protocol.
  const isProtocolCode =
    Number.isInteger(rawCode) &&
    (rawCode as number) >= -32768 &&
    (rawCode as number) <= -32000
  const code = isProtocolCode ? (rawCode as number) : -32000
  let message =
    typeof fields.message === 'string' ? fields.message : 'Internal error'
  const prefix = `MCP error ${code}:`
  if (message.startsWith(prefix)) message = message.slice(prefix.length).trim()
  // Older SDKs spelled the status into the message themselves; newer ones only
  // carry it in the code just discarded, so keep it either way.
  if (
    !isProtocolCode &&
    Number.isInteger(rawCode) &&
    !message.includes(`HTTP ${rawCode}`)
  )
    message = `HTTP ${rawCode}: ${message}`
  // Keep whatever structured detail the upstream error carried: it is the part
  // a client can act on, and rebuilding the error without it discarded the most
  // useful half.
  return respond(req, {
    error: {
      code,
      message,
      ...(fields.data === undefined ? {} : { data: fields.data }),
    },
  })
}
