import type { JSONRPCMessage } from './modernSdk.js'

export class HeaderMismatch extends Error {
  readonly code = -32020
  constructor(readonly header: string) {
    super(`Request header ${header} does not match the request body`)
  }
}

export function decodedHeader(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    !value.startsWith('=?base64?') ||
    !value.endsWith('?=')
  )
    return value
  const payload = value.slice(9, -2)
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      payload,
    )
  )
    return undefined
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Buffer.from(payload, 'base64'),
    )
  } catch {
    return undefined
  }
}

type ReadHeader = (name: string) => string | undefined
export function validateModernHeaders(
  message: JSONRPCMessage,
  header: ReadHeader,
) {
  if (!('id' in message) || !('method' in message)) return
  for (const [key, expected] of [
    [
      'mcp-protocol-version',
      message.params?._meta?.['io.modelcontextprotocol/protocolVersion'],
    ],
    ['mcp-method', message.method],
    ...(message.method === 'tools/call' || message.method === 'prompts/get'
      ? [['mcp-name', message.params?.name]]
      : message.method === 'resources/read'
        ? [['mcp-name', message.params?.uri]]
        : []),
  ]) {
    if (
      typeof expected === 'string' &&
      decodedHeader(header(key as string)) !== expected
    )
      throw new HeaderMismatch(key as string)
  }
}

type ObjectValue = Record<string, unknown>
const object = (value: unknown): ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {}

// Read only statically reachable properties. Do not compile schemas or resolve
// references: this check concerns the HTTP mirrors, not tool argument validity.
export function validateToolHeaders(
  schema: unknown,
  args: unknown,
  header: ReadHeader,
): void {
  for (const [key, property] of Object.entries(
    object(object(schema).properties),
  )) {
    const field = object(property)
    const values = object(args)
    const value = Object.hasOwn(values, key) ? values[key] : undefined
    const name = field['x-mcp-header']
    if (typeof name === 'string' && value !== undefined && value !== null) {
      const headerName = `mcp-param-${name.toLowerCase()}`
      const received = decodedHeader(header(headerName))
      const equal =
        field.type === 'integer' &&
        typeof value === 'number' &&
        received !== undefined &&
        /^-?\d+(\.\d+)?$/.test(received)
          ? Number(received) === value
          : received === String(value)
      if (!equal) throw new HeaderMismatch(headerName)
    }
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
