import type { OutgoingHttpHeaders, ServerResponse } from 'node:http'

const LINE_SEPARATOR = Buffer.from('\\u2028')
const PARAGRAPH_SEPARATOR = Buffer.from('\\u2029')

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

/**
 * Rewrites U+2028 and U+2029 in a stream of UTF-8 bytes as their JSON escapes.
 * A separator split across writes is held until its last byte arrives.
 */
export class SeparatorEscaper {
  private pending: Buffer = Buffer.alloc(0)

  /** The escaped bytes of `chunk`, less any separator still incomplete. */
  encode(chunk: Buffer): Buffer {
    const input = this.pending.length
      ? Buffer.concat([this.pending, chunk])
      : chunk
    this.pending = Buffer.alloc(0)
    let end = input.length
    if (end && input[end - 1] === 0xe2) end--
    else if (end > 1 && input[end - 2] === 0xe2 && input[end - 1] === 0x80)
      end -= 2

    const separators: number[] = []
    for (
      let i = input.indexOf(0xe2);
      i >= 0 && i < end;
      i = input.indexOf(0xe2, i + 1)
    ) {
      // indexOf guarantees the leading byte. A candidate must still have
      // both continuation bytes within this write's complete prefix.
      if (i + 2 >= end || input[i + 1] !== 0x80) continue
      if (input[i + 2] !== 0xa8 && input[i + 2] !== 0xa9) continue
      separators.push(i)
      i += 2
    }
    this.pending = input.subarray(end)
    if (!separators.length) return input.subarray(0, end)
    const output = Buffer.allocUnsafe(end + separators.length * 3)
    let copiedFrom = 0
    let written = 0
    separators.forEach((i) => {
      written += input.copy(output, written, copiedFrom, i)
      const replacement =
        input[i + 2] === 0xa8 ? LINE_SEPARATOR : PARAGRAPH_SEPARATOR
      written += replacement.copy(output, written)
      copiedFrom = i + 3
    })
    input.copy(output, written, copiedFrom, end)
    return output
  }

  /** The last bytes: `chunk` escaped, and whatever was still held. */
  end(chunk: Buffer): Buffer {
    const tail = this.encode(chunk)
    const final = this.pending.length
      ? Buffer.concat([tail, this.pending])
      : tail
    this.pending = Buffer.alloc(0)
    return final
  }
}
