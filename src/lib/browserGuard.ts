import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import type { CorsOptions } from 'cors'
import type { RequestHandler } from 'express'
import type { Logger } from '../types.js'

/**
 * The two ways a web page could use a gateway on its visitor's own machine
 * that has no API key, and the checks that stop them without touching anyone
 * else.
 *
 * Both apply only to connections that arrive on a loopback address, which is
 * where a page in the visitor's browser reaches this machine, and only to
 * requests a browser made: clients that are not browsers send neither
 * `Origin` nor `Sec-Fetch-Site`, so they are never affected. LAN, Docker and
 * remote connections are not loopback, and are not affected either.
 */

/** `--cors` as `corsOrigin.ts` gives it: off, any origin, or a list. */
type Cors = CorsOptions['origin']

/** Whether `--cors` allows `origin`, as the `cors` package decides it. */
export const corsAllows = (cors: Cors, origin: string) =>
  cors === '*' ||
  cors === true ||
  (Array.isArray(cors) &&
    (cors as (string | RegExp)[]).some((item) =>
      typeof item === 'string' ? item === origin : item.test(origin),
    ))

const unbracketed = (hostname: string) => hostname.replace(/^\[|\]$/g, '')

/** A connection that reached this machine on a loopback address. */
export const onLoopback = (req: IncomingMessage) => {
  const address = (req.socket.localAddress ?? '').replace(/^::ffff:/, '')
  return address === '::1' || /^127\./.test(address)
}

/** A name only this machine answers to: localhost, *.localhost or an address. */
export const localName = (hostname: string) =>
  hostname === 'localhost' ||
  hostname.endsWith('.localhost') ||
  isIP(unbracketed(hostname)) !== 0

/** The host name in a `Host` header or an origin, lower case; or undefined. */
export const hostnameOf = (value: string | undefined, scheme = 'http://') => {
  if (!value) return undefined
  try {
    return new URL(value.includes('://') ? value : scheme + value).hostname
  } catch {
    return undefined
  }
}

const FORBIDDEN = (message: string) =>
  JSON.stringify({
    jsonrpc: '2.0',
    error: { code: -32001, message: `Forbidden: ${message}` },
    id: null,
  })

/**
 * A1, DNS rebinding: a page at a name of its own that now points at this
 * machine, asking it same-origin. Its browser sends that name as `Host`.
 *
 * Refused: a browser request on a loopback connection that is same-origin
 * (`Sec-Fetch-Site: same-origin`, or an `Origin` with the `Host`'s name),
 * where `Host` is not a name of this machine nor `--baseUrl`'s, and `--cors`
 * does not allow its origin. A page legitimately served on that same name
 * through a tunnel or proxy here is allowed with `--baseUrl` or `--cors`.
 * Nothing is refused when an API key is set, since a page can't supply one.
 */
export function rebindingRefusal(
  req: IncomingMessage,
  { cors, baseUrl }: { cors: Cors; baseUrl?: string },
): string | undefined {
  if (!onLoopback(req)) return undefined
  const { host, origin } = req.headers
  const name = hostnameOf(host)
  if (name === undefined || localName(name)) return undefined
  const sameOrigin =
    req.headers['sec-fetch-site'] === 'same-origin' ||
    (origin !== undefined && hostnameOf(origin) === name)
  if (!sameOrigin) return undefined
  if (baseUrl !== undefined && hostnameOf(baseUrl) === name) return undefined
  const origins = origin ? [origin] : [`http://${host}`, `https://${host}`]
  if (origins.some((each) => corsAllows(cors, each))) return undefined
  return name
}

/** A1 for the HTTP routes: before everything else on the app. */
export function refuseRebinding({
  cors,
  baseUrl,
  apiKeys,
  logger,
}: {
  cors: Cors
  baseUrl?: string
  apiKeys: string[]
  logger: Logger
}): RequestHandler {
  const told = new Set<string>()
  return (req, res, next) => {
    const name = apiKeys.length
      ? undefined
      : rebindingRefusal(req, { cors, baseUrl })
    if (name === undefined) return next()
    if (!told.has(name)) {
      told.add(name)
      logger.info(rebindingLog(name, baseUrl !== undefined))
    }
    res.status(403).type('application/json').send(FORBIDDEN('host not allowed'))
  }
}

export const rebindingLog = (name: string, sse = false) =>
  `Refused a web page's request for ${name}, which reached this machine on a loopback address (DNS rebinding). If a page served at ${name} uses this gateway, add ${sse ? `--baseUrl https://${name} or ` : ''}--cors with its origin.`

const extension = /^(chrome|moz|safari-web|ms-browser)-extension:\/\//

/**
 * B1: without `--cors` or a key, a web page on another site can't open a
 * WebSocket that arrived on loopback. Allowed: no `Origin` (every client that
 * is not a browser), the gateway's own name, pages on this machine
 * (localhost, *.localhost, an address) and browser extensions.
 */
export function crossSiteRefusal(req: IncomingMessage): boolean {
  const { origin, host } = req.headers
  if (origin === undefined || !onLoopback(req)) return false
  if (extension.test(origin)) return false
  const from = hostnameOf(origin)
  if (from === undefined) return true
  return !localName(from) && from !== hostnameOf(host)
}

export const FORBIDDEN_HOST = FORBIDDEN('host not allowed')
export const FORBIDDEN_ORIGIN = FORBIDDEN('origin not allowed')
