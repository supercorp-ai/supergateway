import type { AddressInfo } from 'node:net'

/**
 * Whether a bound address accepts connections from this machine only.
 * `server.address()` reports the address in its canonical form: `::1` for
 * every spelling of IPv6 loopback, and an IPv4-mapped one in dotted form.
 * All of 127.0.0.0/8 is loopback, not just 127.0.0.1.
 */
export const isLoopback = (address: string) =>
  /^(?:::1|(?:::ffff:)?127\.\d+\.\d+\.\d+)$/i.test(address)

// Addresses that mean "every interface".
const wildcards = new Set(['0.0.0.0', '::'])

// Who can reach the listener, in the words an operator would use.
const reach = ({ address, port }: AddressInfo) =>
  wildcards.has(address)
    ? `port ${port} on this machine (the gateway listens on every network interface)`
    : `${address.includes(':') ? `[${address}]` : address}:${port}`

const quoted = (names: string[]) => {
  const all = names.map((name) => `"${name}"`)
  return all.length === 1
    ? all[0]
    : `${all.slice(0, -1).join(', ')} and ${all[all.length - 1]}`
}

const local = '--host 127.0.0.1 to accept local connections only'

/**
 * The startup warning for a listener that serves MCP without an API key on
 * an address other machines can reach. `open` names the config entries
 * without a key; it is undefined when the command line starts one server.
 */
export function unauthenticatedWarning(bound: AddressInfo, open?: string[]) {
  if (open === undefined)
    return `WARNING: No API key is set, so anyone who can reach ${reach(bound)} can use the MCP server. Set --apiKey or SUPERGATEWAY_API_KEY to require a key, or ${local}.`
  const them = open.length === 1 ? 'it' : 'them'
  return `WARNING: No API key is set for ${quoted(open)}, so anyone who can reach ${reach(bound)} can use ${them}. Set "apiKey" on ${open.length === 1 ? 'that server' : 'those servers'} in the config file, --apiKey or SUPERGATEWAY_API_KEY to require a key on every server, or ${local}.`
}
