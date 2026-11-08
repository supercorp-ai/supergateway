import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from '../types.js'
import { isLoopback } from './unauthenticatedWarning.js'

/**
 * The address `--host` names, as `listen` takes it. URLs write an IPv6
 * address in brackets, and `listen` cannot resolve that form, so `[::1]` and
 * `::1` both mean `::1`.
 */
export const normalizeHost = (host: string) => host.replace(/^\[(.*)\]$/, '$1')

// Addresses that mean "every interface". A gateway can listen on them, but a
// client cannot connect to them.
const wildcards = new Set(['0.0.0.0', '::'])

/**
 * The host the startup log shows clients in its endpoint URLs: the address
 * the gateway listens on, bracketed when it is IPv6, or `localhost` when it
 * listens on every interface.
 */
export function endpointHost(host: string | undefined) {
  if (host === undefined || wildcards.has(host)) return 'localhost'
  return host.includes(':') ? `[${host}]` : host
}

/** The `  - host:` line of a gateway's startup listing, only when one is set. */
export function announceHost(logger: Logger, host: string | undefined) {
  if (host !== undefined) logger.info(`  - host: ${host}`)
}

// Both an Express app and an http.Server.
interface Listenable {
  listen(port: number, onListening: () => void): Server
  listen(port: number, host: string, onListening: () => void): Server
}

export interface ListenerOptions {
  port: number
  /** The address to listen on; every interface when unset. */
  host?: string
  /**
   * Given when at least one MCP server on the listener has no API key; told
   * where the listener bound, once, when other machines can reach it.
   */
  warnUnauthenticated?: (bound: AddressInfo) => void
}

/**
 * Listen on `port`, and on `host` when one is set. Without one the call is
 * `listen(port, …)`, exactly as before `--host` existed: every interface.
 * The warning for a listener without an API key follows the startup listing,
 * so it is the last line an operator sees.
 */
export const listenOn = (
  target: Listenable,
  { port, host, warnUnauthenticated }: ListenerOptions,
  onListening: () => void,
) => {
  const ready = () => {
    onListening()
    if (warnUnauthenticated === undefined) return
    // `listen(port, …)` binds an IP socket, so address() is an AddressInfo.
    const bound = server.address() as AddressInfo
    if (!isLoopback(bound.address)) warnUnauthenticated(bound)
  }
  const server =
    host === undefined
      ? target.listen(port, ready)
      : target.listen(port, host, ready)
  return server
}
