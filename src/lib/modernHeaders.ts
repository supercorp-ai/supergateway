import type { JSONRPCMessage } from './modernSdk.js'

// The JSON-RPC error code of a header that does not mirror the body.
export const HEADER_MISMATCH = -32020

export class HeaderMismatch extends Error {
  readonly code = HEADER_MISMATCH
  constructor(readonly header: string) {
    super(`Request header ${header} does not match the request body`)
  }
}

// A mirrored value can arrive base64-encoded, wrapped as =?base64?...?=.
const ENCODED_PREFIX = '=?base64?'
const ENCODED_SUFFIX = '?='
// Padded base64 only; a payload that is not is no encoded value.
const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

const isEncoded = (value: string) =>
  value.startsWith(ENCODED_PREFIX) && value.endsWith(ENCODED_SUFFIX)

export function decodedHeader(value: string | undefined): string | undefined {
  if (value === undefined || !isEncoded(value)) return value
  const payload = value.slice(ENCODED_PREFIX.length, -ENCODED_SUFFIX.length)
  if (!BASE64.test(payload)) return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(payload, 'base64'),
    )
  } catch {
    return undefined
  }
}

export type ReadHeader = (name: string) => string | undefined

// The request field each method's mcp-name header mirrors.
const NAME_FIELDS = new Map([
  ['tools/call', 'name'],
  ['prompts/get', 'name'],
  ['resources/read', 'uri'],
])

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

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {}

// An integer argument is compared as a number, so a header of "1.0" mirrors
// 1; any other argument as its string form.
const mirrors = (
  field: ObjectValue,
  value: unknown,
  received: string | undefined,
) =>
  field.type === 'integer' &&
  typeof value === 'number' &&
  received !== undefined &&
  /^-?\d+(\.\d+)?$/.test(received)
    ? Number(received) === value
    : received === String(value)

// An argument whose schema names an x-mcp-header must be mirrored in that
// header, when the call gives it a value.
function checkMirroredHeader(
  field: ObjectValue,
  value: unknown,
  header: ReadHeader,
) {
  const name = field['x-mcp-header']
  if (typeof name !== 'string' || value === undefined || value === null) return
  const headerName = `mcp-param-${name.toLowerCase()}`
  if (!mirrors(field, value, decodedHeader(header(headerName))))
    throw new HeaderMismatch(headerName)
}

// Read only statically reachable properties. Do not compile schemas or resolve
// references: this check concerns the HTTP mirrors, not tool argument validity.
export function validateToolHeaders(
  schema: unknown,
  args: unknown,
  header: ReadHeader,
): void {
  const values = object(args)
  for (const [key, property] of Object.entries(
    object(object(schema).properties),
  )) {
    const field = object(property)
    const value = Object.hasOwn(values, key) ? values[key] : undefined
    checkMirroredHeader(field, value, header)
    validateToolHeaders(field, value, header)
  }
}

export async function findToolSchema(
  name: unknown,
  page: (cursor?: string) => Promise<ObjectValue>,
): Promise<unknown> {
  let cursor: string | undefined
  const seen = new Set<string>()
  do {
    const result = await page(cursor)
    if (!Array.isArray(result.tools))
      throw new Error('Invalid tools/list response')
    const tool = result.tools.find((tool) => object(tool).name === name)
    if (tool) return object(tool).inputSchema
    cursor =
      typeof result.nextCursor === 'string' ? result.nextCursor : undefined
    if (cursor !== undefined) {
      if (seen.has(cursor)) throw new Error('Repeated tools/list cursor')
      seen.add(cursor)
    }
  } while (cursor !== undefined)
}
