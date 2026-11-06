import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Logger } from '../types.js'

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
  /** Supplied when at least one MCP server on the listener has no API key. */
  warnUnauthenticated?: (message: string) => void
}

// address() reports the bound IP, including resolved hostnames and
// IPv4-mapped IPv6 addresses in dotted form.
const loopback = /^(?:::1$|127\.|::ffff:127\.)/i

/**
 * Listen on `port`, and on `host` when one is set. Without one the call is
 * `listen(port, …)`, exactly as before `--host` existed: every interface.
 */
export const listenOn = (
  target: Listenable,
  { port, host, warnUnauthenticated }: ListenerOptions,
  onListening: () => void,
) => {
  const ready = () => {
    if (warnUnauthenticated) {
      // The successful listen(port) callback runs with an IP socket bound.
      const { address, port: boundPort } = server.address() as AddressInfo
      if (!loopback.test(address))
        warnUnauthenticated(
          `WARNING: No API key is configured for at least one MCP server on ${address} (port ${boundPort}). Anyone who can reach this listener can use that server. Configure an API key (--apiKey, SUPERGATEWAY_API_KEY, or apiKey in the config entry), or bind to loopback with --host 127.0.0.1.`,
        )
    }
    onListening()
  }
  const server =
    host === undefined
      ? target.listen(port, ready)
      : target.listen(port, host, ready)
  return server
}
