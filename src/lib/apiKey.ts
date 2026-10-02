import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http'
import type { RequestHandler } from 'express'
import type { VerifyClientCallbackAsync } from 'ws'
import type { Logger } from '../types.js'

/**
 * The keys a listening gateway accepts, from every source at once, or why
 * they cannot be used.
 *
 * Every source is a union: `--apiKey` (repeatable), `--apiKeyFile`, and their
 * environment twins `SUPERGATEWAY_API_KEY` and `SUPERGATEWAY_API_KEY_FILE`.
 * No key from any source means no authentication, exactly as before.
 *
 * A source that is present but empty is an error, never "unset". The usual
 * way to get an empty value is a secret that did not resolve
 * (`SUPERGATEWAY_API_KEY=$MISSING`, `--apiKey "$MISSING"`), and reading that
 * as "no key" would start a gateway the operator meant to lock wide open.
 *
 * Keys are trimmed, as file lines are: an HTTP header value arrives without
 * its surrounding whitespace, so a key that kept it could never be presented.
 */
export function apiKeysOf(
  argv: {
    apiKey?: string[]
    apiKeyFile?: string
    outputTransport?: string
  },
  env: Record<string, string | undefined>,
  readFile: (path: string) => string,
): { keys: string[] } | { error: string } {
  const inline: [string, string][] = [
    ...(argv.apiKey ?? []).map((key): [string, string] => ['--apiKey', key]),
    ...named('SUPERGATEWAY_API_KEY', env.SUPERGATEWAY_API_KEY),
  ]
  const files: [string, string][] = [
    ...named('--apiKeyFile', argv.apiKeyFile),
    ...named('SUPERGATEWAY_API_KEY_FILE', env.SUPERGATEWAY_API_KEY_FILE),
  ]
  // `--apiKey` with no value at all parses to an empty list: present, empty.
  if (argv.apiKey === undefined && inline.length === 0 && files.length === 0)
    return { keys: [] }
  // A bridge listens on nothing, so a key there could only be a mistake for
  // the outbound credential. Refused before any file is read.
  if (argv.outputTransport === 'stdio')
    return {
      error:
        'Error: --apiKey applies only when supergateway listens (stdio→SSE, stdio→WS or stdio→Streamable HTTP); to send a key to a remote server use --header or --oauth2Bearer',
    }
  if (argv.apiKey?.length === 0) return { error: emptyError('--apiKey') }

  const keys = new Set<string>()
  for (const [label, key] of inline) {
    if (!key.trim()) return { error: emptyError(label) }
    keys.add(key.trim())
  }
  for (const [label, path] of files) {
    if (!path) return { error: emptyError(label) }
    let content: string
    try {
      content = readFile(path)
    } catch (err) {
      return {
        error: `Error: Cannot read ${label} ${path}: ${(err as Error).message}`,
      }
    }
    const lines = content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if (lines.length === 0)
      return { error: `Error: ${label} ${path} contains no keys` }
    // Never empty here, which is why this is not a `for` loop with a
    // zero-iteration case nothing can reach.
    lines.forEach((line) => keys.add(line))
  }
  return { keys: [...keys] }
}

const named = (label: string, value: string | undefined): [string, string][] =>
  value === undefined ? [] : [[label, value]]

const emptyError = (label: string) =>
  `Error: ${label} is set but empty; give it a value or leave it out`

/** The startup line for the keys, said only when there are any. */
export function logApiKeys(logger: Logger, apiKeys: string[]) {
  if (apiKeys.length === 0) return
  logger.info(
    `  - API key: required (${apiKeys.length} ${apiKeys.length === 1 ? 'key' : 'keys'})`,
  )
}

const digest = (value: Buffer) => createHash('sha256').update(value).digest()

/**
 * Whether a request's headers carry one of the keys, as `Authorization:
 * Bearer <key>` (any case of the scheme) or `X-API-Key: <key>`.
 *
 * Constant-time in the key: both sides are hashed, so the comparison never
 * sees lengths, and every presented value is compared with every key, with no
 * early return on the first match or mismatch.
 *
 * A header value reaches Node as latin1, one character per byte; read back as
 * bytes, a client that sends a UTF-8 key matches the same key configured here.
 */
export function acceptsApiKey(apiKeys: string[]) {
  const expected = apiKeys.map((key) => digest(Buffer.from(key, 'utf8')))
  return (headers: IncomingHttpHeaders): boolean => {
    const bearer = /^bearer[ \t]+(.*)$/i.exec(headers.authorization ?? '')
    const presented = [bearer?.[1], headers['x-api-key']].filter(
      (value) => typeof value === 'string',
    )
    let matched = 0
    for (const value of presented) {
      const actual = digest(Buffer.from(value, 'latin1'))
      // There is always a key: no keys means no check is ever asked for.
      expected.forEach((key) => {
        matched |= Number(timingSafeEqual(actual, key))
      })
    }
    return matched === 1
  }
}

const UNAUTHORIZED_BODY = JSON.stringify({
  jsonrpc: '2.0',
  error: {
    code: -32001,
    message: 'Unauthorized: a valid API key is required',
  },
  id: null,
})

const UNAUTHORIZED_HEADERS = {
  'WWW-Authenticate': 'Bearer realm="supergateway"',
  'Content-Type': 'application/json',
}

// The path only. A client that puts a key in the query string (which is not
// accepted) must not get it logged either.
const rejected = (logger: Logger, req: IncomingMessage) =>
  logger.info(
    `Rejected a request without a valid API key: ${req.method} ${String(req.url).split('?')[0]}`,
  )

/**
 * Express middleware that answers 401 unless the request carries a key.
 * Registered after CORS and the health endpoints, so preflights and probes
 * are answered before it runs. With no keys it passes everything through.
 */
export function requireApiKey(apiKeys: string[], logger: Logger) {
  const accepts = acceptsApiKey(apiKeys)
  const handler: RequestHandler = (req, res, next) => {
    if (apiKeys.length === 0 || accepts(req.headers)) return next()
    rejected(logger, req)
    res.writeHead(401, UNAUTHORIZED_HEADERS).end(UNAUTHORIZED_BODY)
  }
  return handler
}

/**
 * The same check for a WebSocket upgrade, which never reaches express: `ws`
 * answers a refused handshake with this status, body and headers, and never
 * opens the connection. Undefined with no keys, so `ws` checks nothing.
 */
export function verifyApiKey(
  apiKeys: string[],
  logger: Logger,
): VerifyClientCallbackAsync | undefined {
  if (apiKeys.length === 0) return undefined
  const accepts = acceptsApiKey(apiKeys)
  return ({ req }, done) => {
    if (accepts(req.headers)) return done(true)
    rejected(logger, req)
    done(false, 401, UNAUTHORIZED_BODY, UNAUTHORIZED_HEADERS)
  }
}
