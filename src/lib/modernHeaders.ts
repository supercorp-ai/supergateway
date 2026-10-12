import { decodedHeader, encodedHeader } from './encodedHeader.js'
import type { JSONRPCMessage } from './modernSdk.js'
import { type ReadHeader, HeaderMismatch } from './headerMismatch.js'
export {
  HEADER_MISMATCH,
  HeaderMismatch,
  type ReadHeader,
} from './headerMismatch.js'

export { findToolSchema, validateToolHeaders } from './toolHeaders.js'

export { decodedHeader, encodedHeader } from './encodedHeader.js'

// The request field each method's mcp-name header mirrors.
const NAME_FIELDS = new Map([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri'],
])

/** The headers that mirror a message's method, and the name it is for. */
export function mirroredHeaders(message: JSONRPCMessage) {
  const headers: Record<string, string> = {}
  if (!('method' in message)) return headers
  headers['mcp-method'] = encodedHeader(message.method)
  const name = message.params?.[NAME_FIELDS.get(message.method)!]
  if (typeof name === 'string') headers['mcp-name'] = encodedHeader(name)
  return headers
}

export function validateModernHeaders(
  message: JSONRPCMessage,
  header: ReadHeader,
) {
  if (!('id' in message) || !('method' in message)) return
  const mirrored: [string, unknown][] = [
    [
      'mcp-protocol-version',
      message.params?._meta?.['io.modelcontextprotocol/protocolVersion'],
    ],
    ['mcp-method', message.method],
  ]
  const nameField = NAME_FIELDS.get(message.method)
  if (nameField) mirrored.push(['mcp-name', message.params?.[nameField]])
  mirrored.forEach(([key, expected]) => {
    if (typeof expected === 'string' && decodedHeader(header(key)) !== expected)
      throw new HeaderMismatch(key)
  })
}
