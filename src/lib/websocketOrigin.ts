import type { CorsOptions } from 'cors'
import type { VerifyClientCallbackAsync } from 'ws'
import type { Logger } from '../types.js'
import { verifyApiKey } from './apiKey.js'

const FORBIDDEN_BODY = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32001, message: 'Forbidden: origin not allowed' },
  id: null,
})

// Whether `--cors` allows `origin`, as the `cors` package decides it for
// HTTP: a string is the origin exactly, a regular expression one it matches.
const allows = (allowed: (string | RegExp)[], origin: string) =>
  allowed.some((item) =>
    typeof item === 'string' ? item === origin : item.test(origin),
  )

/**
 * The check on a WebSocket upgrade: the API key, as before, then `--cors`.
 *
 * A browser sends `Origin` on a WebSocket handshake but applies no CORS to
 * it, so `--cors` is checked here: an upgrade with an `Origin` that `--cors`
 * lists none of is refused with 403.
 *
 * Nothing else changes: a client that sends no `Origin` (every client that is
 * not a browser), bare `--cors`, and a gateway without `--cors` accept what
 * they always have. Without `--cors` or a key, each web page origin that
 * connects is logged once, so an operator can see who uses the gateway.
 */
export function verifyWebSocket(
  corsOrigin: CorsOptions['origin'],
  apiKeys: string[],
  logger: Logger,
): VerifyClientCallbackAsync {
  const key = verifyApiKey(apiKeys, logger)
  // corsOrigin.ts lists strings and expressions; `true` is never one of them.
  const listed = Array.isArray(corsOrigin)
    ? (corsOrigin as (string | RegExp)[])
    : undefined
  const unprotected = !corsOrigin && apiKeys.length === 0
  const seen = new Set<string>()
  const byOrigin: VerifyClientCallbackAsync = ({ req }, done) => {
    const { origin } = req.headers
    if (origin === undefined) return done(true)
    if (listed && !allows(listed, origin)) {
      logger.info(
        `Refused a WebSocket connection from ${origin}: not in --cors`,
      )
      return done(false, 403, FORBIDDEN_BODY, {
        'Content-Type': 'application/json',
      })
    }
    if (unprotected && !seen.has(origin)) {
      seen.add(origin)
      logger.info(
        `A web page at ${origin} connected over WebSocket. --cors limits which origins can.`,
      )
    }
    done(true)
  }
  if (!key) return byOrigin
  return (info, done) =>
    key(info, (accepted, ...refusal) =>
      accepted ? byOrigin(info, done) : done(false, ...refusal),
    )
}
