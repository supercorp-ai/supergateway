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
  let pending = Buffer.alloc(0)

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

  const encode = (chunk: Buffer): Buffer => {
    const input = pending.length ? Buffer.concat([pending, chunk]) : chunk
    pending = Buffer.alloc(0)
    let end = input.length
    if (end && input[end - 1] === 0xe2) end--
    else if (end > 1 && input[end - 2] === 0xe2 && input[end - 1] === 0x80)
      end -= 2

    const isSeparator = (index: number) =>
      index + 2 < end &&
      input[index] === 0xe2 &&
      input[index + 1] === 0x80 &&
      (input[index + 2] === 0xa8 || input[index + 2] === 0xa9)

    const separators: number[] = []
    for (
      let i = input.indexOf(0xe2);
      i >= 0 && i < end;
      i = input.indexOf(0xe2, i + 1)
    ) {
      if (isSeparator(i)) {
        separators.push(i)
        i += 2
      }
    }
    pending = input.subarray(end)
    if (!separators.length) return input.subarray(0, end)
    const output = Buffer.allocUnsafe(end + separators.length * 3)
    let copiedFrom = 0
    let written = 0
    for (const i of separators) {
      written += input.copy(output, written, copiedFrom, i)
      const replacement =
        input[i + 2] === 0xa8 ? LINE_SEPARATOR : PARAGRAPH_SEPARATOR
      written += replacement.copy(output, written)
      copiedFrom = i + 3
    }
    input.copy(output, written, copiedFrom, end)
    return output
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
    const withoutLength = headerObject
      ? (Object.fromEntries(
          Object.entries(headerObject).filter(
            ([name]) => name.toLowerCase() !== 'content-length',
          ),
        ) as OutgoingHttpHeaders)
      : undefined
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
    return originalWrite(encode(bytes), done)
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
    const tail = encode(bytes)
    const final = pending.length ? Buffer.concat([tail, pending]) : tail
    pending = Buffer.alloc(0)
    return originalEnd(final, done)
  }) as typeof res.end
}
