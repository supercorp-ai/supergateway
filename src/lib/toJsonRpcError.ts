/** Convert arbitrary JavaScript failures into a valid JSON-RPC error object. */
export function toJsonRpcError(error: unknown): {
  code: number
  message: string
} {
  const candidate = error !== null && typeof error === 'object' ? error : {}
  const code =
    'code' in candidate &&
    typeof candidate.code === 'number' &&
    Number.isInteger(candidate.code)
      ? candidate.code
      : -32000
  let message =
    'message' in candidate && typeof candidate.message === 'string'
      ? candidate.message
      : 'Internal error'
  const prefix = `MCP error ${code}:`
  if (message.startsWith(prefix)) {
    message = message.slice(prefix.length).trim()
  }
  return { code, message }
}
