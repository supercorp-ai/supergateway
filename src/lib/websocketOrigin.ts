import type { CorsOptions } from 'cors'
import type { VerifyClientCallbackAsync } from 'ws'
import type { Logger } from '../types.js'
import { verifyApiKey } from './apiKey.js'
import {
  corsAllows,
  crossSiteRefusal,
  FORBIDDEN_HOST,
  FORBIDDEN_ORIGIN,
  rebindingLog,
  rebindingRefusal,
} from './browserGuard.js'

const JSON_TYPE = { 'Content-Type': 'application/json' }

/**
 * The check on a WebSocket upgrade: the API key, as before, then `--cors`.
 *
 * A browser sends `Origin` on a WebSocket handshake but applies no CORS to
 * it, so `--cors` is checked here: an upgrade with an `Origin` that `--cors`
 * lists none of is refused with 403.
 *
 * Without a key, two more refusals, both only for a browser's upgrade that
 * arrived on loopback (browserGuard.ts): DNS rebinding, and, without
 * `--cors` either, a page on another site.
 *
 * A client that sends no `Origin` (every client that is not a browser) is
 * never refused by origin. Without `--cors` or a key, each web page origin
 * that connects is logged once, so an operator can see who uses the gateway.
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
  const told = new Set<string>()
  const once = (line: string) => {
    if (told.has(line)) return
    told.add(line)
    logger.info(line)
  }
  const byOrigin: VerifyClientCallbackAsync = ({ req }, done) => {
    const { origin } = req.headers
    if (origin === undefined) return done(true)
    const rebound =
      apiKeys.length === 0
        ? rebindingRefusal(req, { cors: corsOrigin })
        : undefined
    if (rebound !== undefined) {
      once(rebindingLog(rebound))
      return done(false, 403, FORBIDDEN_HOST, JSON_TYPE)
    }
    if (listed && !corsAllows(listed, origin)) {
      logger.info(
        `Refused a WebSocket connection from ${origin}: not in --cors`,
      )
      return done(false, 403, FORBIDDEN_ORIGIN, JSON_TYPE)
    }
    if (unprotected && crossSiteRefusal(req)) {
      once(
        `Refused a WebSocket connection from ${origin}: a web page on another site, on this machine's loopback address, and no --cors. Add --cors ${origin} to allow it.`,
      )
      return done(false, 403, FORBIDDEN_ORIGIN, JSON_TYPE)
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
