const LINE_SEPARATOR = Buffer.from('\\u2028')
const PARAGRAPH_SEPARATOR = Buffer.from('\\u2029')

// U+2028 is E2 80 A8 in UTF-8 and U+2029 is E2 80 A9: three bytes each, the
// first two shared.
const FIRST_BYTE = 0xe2
const SECOND_BYTE = 0x80
const LINE_LAST_BYTE = 0xa8
const PARAGRAPH_LAST_BYTE = 0xa9
const SEPARATOR_BYTES = 3
// A six-character JSON escape takes the place of three bytes.
const GROWTH_PER_SEPARATOR = LINE_SEPARATOR.length - SEPARATOR_BYTES

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
    const end = input.length - unfinishedSeparator(input)

    const separators: number[] = []
    for (
      let i = input.indexOf(FIRST_BYTE);
      i >= 0 && i < end;
      i = input.indexOf(FIRST_BYTE, i + 1)
    ) {
      // indexOf guarantees the leading byte. A candidate must still have
      // both continuation bytes within this write's complete prefix.
      const isWhole = i + SEPARATOR_BYTES - 1 < end
      if (!isWhole || input[i + 1] !== SECOND_BYTE) continue
      if (!isLastByte(input[i + 2])) continue
      separators.push(i)
      i += SEPARATOR_BYTES - 1
    }
    this.pending = input.subarray(end)
    if (!separators.length) return input.subarray(0, end)
    const output = Buffer.allocUnsafe(
      end + separators.length * GROWTH_PER_SEPARATOR,
    )
    let copiedFrom = 0
    let written = 0
    separators.forEach((i) => {
      written += input.copy(output, written, copiedFrom, i)
      const replacement =
        input[i + 2] === LINE_LAST_BYTE ? LINE_SEPARATOR : PARAGRAPH_SEPARATOR
      written += replacement.copy(output, written)
      copiedFrom = i + SEPARATOR_BYTES
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

const isLastByte = (byte: number) =>
  byte === LINE_LAST_BYTE || byte === PARAGRAPH_LAST_BYTE

// How many bytes at the end of `input` may be the start of a separator whose
// rest has not arrived: its first byte, or its first two.
function unfinishedSeparator(input: Buffer): number {
  const { length } = input
  if (length > 0 && input[length - 1] === FIRST_BYTE) return 1
  const endsWithFirstTwo =
    length > 1 &&
    input[length - 2] === FIRST_BYTE &&
    input[length - 1] === SECOND_BYTE
  return endsWithFirstTwo ? 2 : 0
}
