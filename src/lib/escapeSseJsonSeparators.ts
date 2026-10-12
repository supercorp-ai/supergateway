import type { ServerResponse, OutgoingHttpHeaders } from 'node:http'
import { SeparatorEscaper } from './separatorEscaper.js'
export { SeparatorEscaper } from './separatorEscaper.js'

// The SDK serializes each MCP message as JSON in an SSE `data:` field. Raw
// U+2028/U+2029 are valid there, but some clients incorrectly split on every
// Unicode line separator. Replacing their UTF-8 bytes with JSON escapes keeps
// the parsed MCP value identical without changing the SDK's message objects.
export function escapeSseJsonSeparators(res: ServerResponse): void {
  const originalWriteHead = res.writeHead.bind(res)
  const originalWrite = res.write.bind(res)
  const originalEnd = res.end.bind(res)
  let sse = false
  const escaper = new SeparatorEscaper()

  const isSse = (headers?: OutgoingHttpHeaders) => {
    const contentType =
      Object.entries(headers ?? {}).find(
        ([name]) => name.toLowerCase() === 'content-type',
      )?.[1] ?? res.getHeader('content-type')
    return String(contentType ?? '')
      .toLowerCase()
      .startsWith('text/event-stream')
  }

  const activate = () => {
    if (sse) return
    sse = true
    // Escapes are longer than the original UTF-8 bytes. The adapter sometimes
    // precomputes Content-Length for a short SSE response; use chunked framing.
    if (!res.headersSent) res.removeHeader('content-length')
  }

  res.writeHead = ((
    status: number,
    reasonOrHeaders?: string | OutgoingHttpHeaders,
    headers?: OutgoingHttpHeaders,
  ) => {
    const headerObject =
      headers ??
      (typeof reasonOrHeaders === 'object' ? reasonOrHeaders : undefined)
    if (!isSse(headerObject)) {
      return typeof reasonOrHeaders === 'string'
        ? originalWriteHead(status, reasonOrHeaders, headers)
        : originalWriteHead(status, reasonOrHeaders)
    }
    activate()
    const withoutLength = headerObject && withoutContentLength(headerObject)
    if (typeof reasonOrHeaders === 'string') {
      return originalWriteHead(status, reasonOrHeaders, withoutLength)
    }
    return originalWriteHead(status, withoutLength)
  }) as typeof res.writeHead

  res.write = ((
    chunk: Uint8Array | string,
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    if (!sse && isSse()) activate()
    if (!sse) return originalWrite(chunk, encoding as BufferEncoding, callback)
    const done = typeof encoding === 'function' ? encoding : callback
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
        : Buffer.from(chunk)
    return originalWrite(escaper.encode(bytes), done)
  }) as typeof res.write

  res.end = ((
    chunk?: Uint8Array | string | (() => void),
    encoding?: BufferEncoding | (() => void),
    callback?: () => void,
  ) => {
    if (!sse && isSse()) activate()
    if (!sse)
      return originalEnd(chunk as string, encoding as BufferEncoding, callback)
    const done =
      typeof chunk === 'function'
        ? chunk
        : typeof encoding === 'function'
          ? encoding
          : callback
    const bytes =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8')
        : chunk && typeof chunk !== 'function'
          ? Buffer.from(chunk)
          : Buffer.alloc(0)
    return originalEnd(escaper.end(bytes), done)
  }) as typeof res.end
}

const withoutContentLength = (headers: OutgoingHttpHeaders) =>
  Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== 'content-length',
    ),
  ) as OutgoingHttpHeaders
