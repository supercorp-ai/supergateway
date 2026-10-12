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

/**
 * A value as a header can carry it: as it is when it is plain visible ASCII
 * with nothing to trim, base64-wrapped otherwise.
 */
export const encodedHeader = (value: string) =>
  /^[\x21-\x7e]([\x20-\x7e]*[\x21-\x7e])?$/.test(value) && !isEncoded(value)
    ? value
    : `${ENCODED_PREFIX}${Buffer.from(value, 'utf8').toString('base64')}${ENCODED_SUFFIX}`
