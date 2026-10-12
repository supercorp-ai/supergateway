import {
  type JSONRPCRequest,
  InitializeRequestSchema,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js'

/**
 * Whether a request failed because the upstream no longer serves this
 * connection, so the next request needs a fresh one.
 *
 * A 404 means the server no longer recognizes this MCP session. A fresh
 * transport must initialize before the next stdio request. Never replay the
 * failed request: a tool call may have had side effects.
 */
export const upstreamLost = (err: unknown) => {
  const rawCode =
    err && typeof err === 'object' && 'code' in err
      ? (err as { code: unknown }).code
      : undefined
  const transportHttpFailure =
    err instanceof Error &&
    /^Streamable HTTP error: Error POSTing to endpoint:/.test(err.message) &&
    (rawCode === 404 || (typeof rawCode === 'number' && rawCode >= 500))
  const fetchFailed =
    err instanceof TypeError && /fetch failed/i.test(err.message)
  // SDK 1.18-1.23 wrap HTTP failures in a generic MCP error rather than
  // exposing the status as `code`. Recognize that transport's specific message
  // too, so an expired session reconnects there.
  const legacyHttpFailure =
    err instanceof Error &&
    /^(?:MCP error -32000: )?Error POSTing to endpoint \(HTTP (?:404|5\d\d)\):/.test(
      err.message,
    )
  return transportHttpFailure || fetchFailed || legacyHttpFailure
}

/**
 * Refuse an initialize request with malformed params, as invalid params,
 * before anything is sent upstream.
 */
export const rejectMalformedInitialize = (req: JSONRPCRequest) => {
  if (
    req.method === 'initialize' &&
    req.params !== undefined &&
    !InitializeRequestSchema.safeParse(req).success
  ) {
    throw Object.assign(new Error('Invalid initialize parameters'), {
      code: ErrorCode.InvalidParams,
    })
  }
}
