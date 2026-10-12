import type { Route } from './modernAdmission.js'
import { HEADER_MISMATCH } from './modernHeaders.js'
import type { JSONRPCMessage } from './modernSdk.js'
import type { RetainedChildren } from './retainedChildren.js'

export type Reused = Awaited<ReturnType<RetainedChildren['take']>>

// A continuation's message carries the server's own request state again, in
// place of the gateway's handle, or none if the server minted none.
export const restoredState = (
  message: Route['message'],
  reused: Reused,
): Route['message'] => {
  if (!reused) return message
  const restored: Route['message'] = {
    ...message,
    params: { ...message.params },
  }
  delete restored.params!.requestState
  if (reused.state !== undefined) restored.params!.requestState = reused.state
  return restored
}
const METHOD_NOT_FOUND = -32601
const INTERNAL_ERROR = -32603
// The 2026-07-28 errors about the request's framing: a header that does not
// mirror the body, a missing client capability, an unsupported version.
const FRAMING_ERRORS = [HEADER_MISMATCH, -32021, -32022]

export const PROCESS_FAILED = {
  code: INTERNAL_ERROR,
  message: 'MCP server process failed',
}

// The child asking something of the client, which a modern request cannot.
export const isRequest = (message: JSONRPCMessage) =>
  'method' in message && 'id' in message

// A JSON response with the status its reply calls for. Once SSE headers are
// sent, errors must remain on that stream.
export const withStatus = (response: globalThis.Response, status: number) =>
  response.headers.get('content-type') === 'application/json' &&
  status !== response.status
    ? new globalThis.Response(response.body, {
        status,
        headers: response.headers,
      })
    : response

// The tool call's _meta for the gateway's own tools/list: the call's progress
// token names the client's request, which this is not.
export const withoutProgressToken = (
  callMeta: Record<string, unknown> | undefined,
) => {
  const meta: Record<string, unknown> = { ...callMeta }
  delete meta.progressToken
  return meta
}

// The HTTP status of a JSON reply carrying this error: an unknown method is a
// 404, a framing error a 400, and any other error rides a 200.
export const statusForError = (code: number) =>
  code === METHOD_NOT_FOUND ? 404 : FRAMING_ERRORS.includes(code) ? 400 : 200

export function mintedState(
  result: Record<string, unknown>,
): { value: string | undefined } | undefined {
  const { resultType, requestState } = result as Record<string, unknown>
  return resultType === 'input_required' &&
    (requestState === undefined || typeof requestState === 'string')
    ? { value: requestState as string | undefined }
    : undefined
}
