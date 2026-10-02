import { Logger } from '../types.js'

type Level = 'info' | 'error'

/**
 * A logged value as plain JSON data.
 *
 * `JSON.stringify` alone writes an Error as `{}`, throws on a BigInt and
 * throws on a cycle. Each of those can reach the logger (a failed request's
 * error, a message that holds one), and the logger must never be what takes
 * the gateway down.
 */
const plain = (value: unknown, ancestors: object[] = []): unknown => {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object' || value === null) return value
  if (ancestors.includes(value)) return '[Circular]'
  const inside = [...ancestors, value]
  if (value instanceof Error)
    // An absent code is undefined, which JSON leaves out.
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: plain((value as NodeJS.ErrnoException).code, inside),
    }
  const json = (value as { toJSON?: () => unknown }).toJSON
  if (typeof json === 'function') return plain(json.call(value), inside)
  if (Array.isArray(value)) return value.map((item) => plain(item, inside))
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, plain(item, inside)]),
  )
}

/**
 * One log call as one line of JSON, with slog's keys.
 *
 * The string arguments are the message, as they are in the text format; any
 * other argument is data. A message that spans lines (a child's stderr) stays
 * on one, because JSON escapes the newlines.
 */
export const jsonLine = (
  level: Level,
  args: unknown[],
  time = new Date(),
): string => {
  const msg = args.filter((arg) => typeof arg === 'string').join(' ')
  const values = args.filter((arg) => typeof arg !== 'string')
  const entry = { time: time.toISOString(), level, msg }
  if (values.length === 0) return JSON.stringify(entry)
  try {
    return JSON.stringify({
      ...entry,
      data: plain(values.length === 1 ? values[0] : values),
    })
  } catch {
    // A getter or toJSON that throws. The message is still worth having.
    return JSON.stringify({ ...entry, data: '[Unserializable]' })
  }
}

/** Info and errors on the same streams the text format uses. */
export const jsonLogger = (outputTransport: string): Logger => ({
  info:
    outputTransport === 'stdio'
      ? (...args) => console.error(jsonLine('info', args))
      : (...args) => console.log(jsonLine('info', args)),
  error: (...args) => console.error(jsonLine('error', args)),
})
