// Bound raw bytes before decoding or parsing. Geometric growth also bounds the
// number of allocations when a peer delivers a long line one byte at a time.
export function stdoutLines(
  maxBytes: number | undefined,
  onLine: (line: string) => void,
  onOverflow: () => void,
): (chunk: Buffer) => void {
  const limit = maxBytes ?? Infinity
  let pending = Buffer.alloc(0)
  let length = 0
  let failed = false
  return (chunk) => {
    if (failed) return
    let offset = 0
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset)
      const end = newline === -1 ? chunk.length : newline
      const size = end - offset
      if (length + size > limit) {
        failed = true
        pending = Buffer.alloc(0)
        onOverflow()
        return
      }
      if (newline !== -1 && length === 0) {
        onLine(chunk.toString('utf8', offset, end).replace(/\r$/, ''))
      } else {
        if (size > 0) {
          const required = length + size
          if (pending.length < required) {
            const grown = Buffer.allocUnsafe(
              Math.min(limit, Math.max(required, pending.length * 2, 4096)),
            )
            pending.copy(grown, 0, 0, length)
            pending = grown
          }
          chunk.copy(pending, length, offset, end)
          length += size
        }
        if (newline !== -1) {
          const line = pending.toString('utf8', 0, length).replace(/\r$/, '')
          length = 0
          pending = Buffer.alloc(0)
          onLine(line)
        }
      }
      offset = newline === -1 ? end : end + 1
    }
  }
}
