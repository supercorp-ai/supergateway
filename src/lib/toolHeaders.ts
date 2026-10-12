import { type ReadHeader, HeaderMismatch } from './headerMismatch.js'
import { decodedHeader } from './encodedHeader.js'

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
