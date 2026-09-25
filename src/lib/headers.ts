import { Logger } from '../types.js'

/**
 * Header names whose *value* must never reach a log.
 *
 * Matched on whole `-`/`_`-separated segments rather than as substrings, so
 * `x-api-key` redacts and `x-monkey` does not. Names are still printed: knowing
 * which headers are configured is the useful half, and it is the half three
 * gateways were failing to report at all (GW-006).
 */
const SENSITIVE_SEGMENTS = new Set([
  'apikey',
  'auth',
  'authorization',
  'cookie',
  'credential',
  'credentials',
  'key',
  'passwd',
  'password',
  'secret',
  'session',
  'signature',
  'token',
])

export const isSensitiveHeader = (name: string): boolean =>
  name
    .toLowerCase()
    .split(/[-_]/)
    .some((segment) => SENSITIVE_SEGMENTS.has(segment))

/**
 * How a gateway reports its configured headers at startup.
 *
 * Two separate bugs used to live in this one line. Three gateways wrote
 * `Object(headers).length`, which is `undefined` for any ordinary object and so
 * always falsy — they reported configured headers as absent (GW-006). Note that
 * `Object.keys(...).length` is the only correct spelling: `headers.length`
 * would read the value of a header actually *named* `length`, which is legal and
 * which `headerNamesE2e.test.ts` already exercises.
 *
 * The two gateways that spelled it correctly printed the values, so
 * `--oauth2Bearer` put the token verbatim into the startup log at the default
 * log level (GW-029) — and in a container that goes straight to the platform's
 * log store.
 */
export const describeHeaders = (headers: Record<string, string>): string => {
  const names = Object.keys(headers)
  if (names.length === 0) return '(none)'
  return JSON.stringify(
    Object.fromEntries(
      names.map((name) => [
        name,
        isSensitiveHeader(name) ? '<redacted>' : headers[name],
      ]),
    ),
  )
}

const parseHeaders = ({
  argvHeader,
  logger,
}: {
  argvHeader: (string | number)[]
  logger: Logger
}): Record<string, string> => {
  return argvHeader.reduce<Record<string, string>>((acc, rawHeader) => {
    const header = `${rawHeader}`

    const colonIndex = header.indexOf(':')
    if (colonIndex === -1) {
      // Only the first token, never the whole argument. `--header
      // "Authorization Bearer abc"` is a plausible typo, and echoing it back
      // would put the credential in the log by a second route. The first token
      // is the part that identifies which argument was wrong.
      logger.error(`Invalid header format: ${header.split(/\s/)[0]}, ignoring`)
      return acc
    }

    const key = header.slice(0, colonIndex).trim()
    const value = header.slice(colonIndex + 1).trim()

    if (!key || !value) {
      // Only the name. With the name missing the rest is a bare value, and
      // `--header ": Bearer abc"` would otherwise put the credential in the log.
      logger.error(
        `Invalid header format: ${key || '(missing name)'}, ignoring`,
      )
      return acc
    }

    acc[key] = value
    return acc
  }, {})
}

export const headers = ({
  argv,
  logger,
}: {
  argv: {
    header: (string | number)[]
    oauth2Bearer: string | undefined
  }
  logger: Logger
}): Record<string, string> => {
  const headers = parseHeaders({
    argvHeader: argv.header,
    logger,
  })

  if ('oauth2Bearer' in argv) {
    return {
      ...headers,
      Authorization: `Bearer ${argv.oauth2Bearer}`,
    }
  }

  return headers
}
