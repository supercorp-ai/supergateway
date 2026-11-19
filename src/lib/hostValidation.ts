import { networkInterfaces } from 'node:os'
import type { IncomingMessage } from 'node:http'
import type { RequestHandler } from 'express'
import type { Logger } from '../types.js'

/**
 * Host names a client on the machine itself sends: the loopback names, in
 * both the plain and the bracketed IPv6 spelling.
 */
const loopbackNames = ['localhost', '127.0.0.1', '[::1]', '::1']

/**
 * The Host header without its port. Bracketed IPv6 keeps its brackets
 * (`[::1]:8000` gives `[::1]`); the rest cuts at the last colon
 * (`localhost:8000` gives `localhost`).
 */
export const hostName = (host: string) => {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end === -1 ? host : host.slice(0, end + 1)
  }
  // `host:port` has one colon; bare IPv6 has more. An IPv6 Host without
  // brackets is not what a browser sends, but it stays whole rather than
  // losing half of itself to a port cut that cannot tell them apart.
  const colon = host.lastIndexOf(':')
  if (colon === -1 || host.indexOf(':') !== colon) return host
  return host.slice(0, colon)
}

// Every address of this machine, so a gateway listening on every interface
// keeps answering LAN clients that arrive by address.
export const localAddresses = () => {
  const found: string[] = []
  for (const list of Object.values(networkInterfaces()))
    for (const iface of list ?? []) if (iface) found.push(iface.address)
  return found
}

/**
 * The Host names this gateway answers as: the loopback names, the address
 * `--host` names, every address of the machine, and anything `--allow-host`
 * adds.
 *
 * Anything else in a Host header is a rebound domain: a page on the web
 * resolving a name it owns to 127.0.0.1 and driving the gateway from there
 * (DNS rebinding). The browser sends that page's own name as the Host, so
 * rejecting Host names outside this list keeps the gateway out of its reach
 * without touching any real client.
 */
export function acceptedHosts(
  host: string | undefined,
  allowHost: string[] | undefined,
): string[] {
  const names = new Set(loopbackNames.map((name) => name.toLowerCase()))
  for (const address of [host, ...localAddresses()]) {
    if (!address) continue
    const lower = address.toLowerCase()
    names.add(lower)
    if (lower.includes(':')) names.add(`[${lower}]`)
  }
  for (const name of allowHost ?? []) names.add(name.toLowerCase())
  return [...names]
}

// Whether a request's Host names the gateway.
const acceptsHost = (accepted: Set<string>, req: IncomingMessage) => {
  const raw = req.headers.host
  return typeof raw === 'string' && accepted.has(hostName(raw).toLowerCase())
}

const FORBIDDEN_BODY = { error: 'Forbidden Host header' }

/** The express middleware that rejects a rebound or missing Host with 403. */
export function validateHost(
  accepted: string[],
  logger: Logger,
): RequestHandler {
  const allowed = new Set(accepted.map((name) => name.toLowerCase()))
  return (req, res, next) => {
    if (acceptsHost(allowed, req)) return next()
    logger.info(
      `Rejected request: Host header ${String(req.headers.host)} is not this gateway`,
    )
    res.status(403).json(FORBIDDEN_BODY)
  }
}

/**
 * The same check for a WebSocket upgrade, which express does not see. Returns
 * a verifyClient callback that rejects with 403 before any API key check.
 */
export function verifyWsHost(
  accepted: string[],
  logger: Logger,
): (
  info: {
    req: IncomingMessage
  },
  done: (ok: boolean, code?: number, message?: string) => void,
) => void {
  const allowed = new Set(accepted.map((name) => name.toLowerCase()))
  return ({ req }, done) => {
    if (acceptsHost(allowed, req)) return done(true)
    logger.info(
      `Rejected upgrade: Host header ${String(req.headers.host)} is not this gateway`,
    )
    done(false, 403, JSON.stringify(FORBIDDEN_BODY))
  }
}
