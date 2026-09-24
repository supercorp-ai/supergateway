import { BlockList } from 'node:net'
import type { IncomingHttpHeaders, ServerResponse } from 'node:http'

// Addresses a client can only reach from inside the network they name. An
// absolute endpoint on one of these helps no client that needs one — those are
// hosted services, and they cannot reach it — while a proxy that rewrites
// `Host` to exactly such an address would make it look like the client's own.
const privateAddresses = new BlockList()
privateAddresses.addSubnet('0.0.0.0', 8, 'ipv4')
privateAddresses.addSubnet('10.0.0.0', 8, 'ipv4')
privateAddresses.addSubnet('100.64.0.0', 10, 'ipv4')
privateAddresses.addSubnet('127.0.0.0', 8, 'ipv4')
privateAddresses.addSubnet('169.254.0.0', 16, 'ipv4')
privateAddresses.addSubnet('172.16.0.0', 12, 'ipv4')
privateAddresses.addSubnet('192.168.0.0', 16, 'ipv4')
privateAddresses.addSubnet('::', 127, 'ipv6')
privateAddresses.addSubnet('fc00::', 7, 'ipv6')
privateAddresses.addSubnet('fe80::', 10, 'ipv6')

const isPrivateHost = (hostname: string) => {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const family = /^[\d.]+$/.test(host)
    ? 'ipv4'
    : host.includes(':')
      ? 'ipv6'
      : ''
  if (family) return privateAddresses.check(host, family)
  // A single label (`gateway`, a container or service name) and the reserved
  // local suffixes resolve only on the network that defines them.
  return (
    !host.includes('.') ||
    /\.(localhost|local|internal|lan|home\.arpa)$/.test(host)
  )
}

const DEFAULT_PORTS: Record<string, string> = { http: '80', https: '443' }

// `Host: pub.example:443` and `https://pub.example` name the same origin.
const sameAuthority = (a: string, b: string, scheme: string) => {
  const normalize = (authority: string) =>
    authority
      .toLowerCase()
      .replace(new RegExp(`:${DEFAULT_PORTS[scheme]}$`), '')
  return normalize(a) === normalize(b)
}

// A proxy chain appends, so the first value is the one the client sent. Node
// joins repeated headers of this kind into one comma-separated string; only
// `set-cookie` ever arrives as an array.
const firstValue = (header: string | string[] | undefined) =>
  (header as string | undefined)?.split(',')[0].trim() || undefined

/**
 * The origin to put in front of an SSE `endpoint` event, or `undefined` to
 * leave the event relative.
 *
 * Since SDK 1.9 the endpoint event carries only a path, so `--baseUrl`'s
 * scheme, host and port never reach the client (#46). Clients that need an
 * absolute endpoint, such as Microsoft Copilot Studio, cannot use a relative
 * one. Restoring it unconditionally is not safe: the TypeScript and Python SDK
 * clients reject an endpoint whose origin differs from the one they connected
 * to, so a `--baseUrl` that does not match how a client connects works today
 * only because it is ignored.
 *
 * The request says how this client connected. When `--baseUrl` names exactly
 * that origin — scheme, host and port, taking a proxy's `X-Forwarded-Host` and
 * `X-Forwarded-Proto` over its own `Host` — the absolute endpoint resolves to
 * the same URL as the relative one for every client that resolves it, so it
 * breaks none of them and serves the ones that need it. On any other evidence,
 * including none, the endpoint stays relative, as it is today.
 *
 * The origin is built from the authority the client itself sent rather than
 * from `--baseUrl`: the Python client compares the two as literal strings, so
 * `pub.example` and `pub.example:443` would not match.
 */
export function sseEndpointOrigin(
  baseUrl: string,
  headers: IncomingHttpHeaders,
): string | undefined {
  if (!baseUrl) return undefined
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    return undefined
  }
  const scheme = base.protocol.slice(0, -1)
  if (!(scheme in DEFAULT_PORTS)) return undefined
  if (isPrivateHost(base.hostname)) return undefined
  const authority = firstValue(headers['x-forwarded-host']) ?? headers.host
  if (!authority) return undefined
  // Without a proxy saying otherwise, the gateway itself serves plain HTTP.
  const connectedScheme = firstValue(headers['x-forwarded-proto']) ?? 'http'
  if (connectedScheme.toLowerCase() !== scheme) return undefined
  if (!sameAuthority(authority, base.host, scheme)) return undefined
  return `${scheme}://${authority}`
}

/**
 * Prefix the SDK's relative endpoint event with `origin`. The SDK writes that
 * event immediately after the response headers, as its first write, so this
 * rewrites one write and then gets out of the way.
 */
export function absolutizeSseEndpoint(res: ServerResponse, origin: string) {
  const write = res.write
  res.write = function (this: ServerResponse, chunk: any, ...rest: any[]) {
    res.write = write
    const text = String(chunk)
    return text.startsWith('event: endpoint\ndata: /')
      ? write.call(
          this,
          text.replace('data: /', `data: ${origin}/`),
          ...(rest as [any]),
        )
      : write.call(this, chunk, ...(rest as [any]))
  } as typeof res.write
}
