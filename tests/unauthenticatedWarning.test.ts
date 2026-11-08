import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  isLoopback,
  unauthenticatedWarning,
} from '../src/lib/unauthenticatedWarning.js'
import { listenOn } from '../src/lib/listenHost.js'

// #360: a listener that serves MCP without an API key, on an address other
// machines can reach, says so once at startup. These are the pieces: which
// addresses count as local, the words, and when listenOn says them.

const bound = (address: string, port = 8000): AddressInfo => ({
  address,
  port,
  family: address.includes(':') ? 'IPv6' : 'IPv4',
})

test('loopback addresses, as server.address() reports them', () => {
  for (const address of [
    '127.0.0.1',
    '127.0.0.2',
    '127.1.2.3',
    '127.255.255.255',
    '::1',
    '::ffff:127.0.0.1',
    '::FFFF:127.0.0.1',
    '::ffff:127.9.9.9',
  ])
    assert.equal(isLoopback(address), true, address)
})

test('every other address is reachable from elsewhere', () => {
  for (const address of [
    '0.0.0.0',
    '::',
    '192.168.1.5',
    '10.0.0.1',
    '172.16.0.1',
    '128.0.0.1',
    '126.255.255.255',
    // Look like loopback only to a prefix or suffix match.
    '1127.0.0.1',
    '127.0.0.1.5',
    '127.0.0',
    '::11',
    '::1:1',
    '1::1',
    'fe80::1',
    '2001:db8::1',
    '::ffff:192.168.1.5',
    '::ffff:0.0.0.0',
    '',
  ])
    assert.equal(isLoopback(address), false, address)
})

const local =
  'Set --apiKey or SUPERGATEWAY_API_KEY to require a key, or --host 127.0.0.1 to accept local connections only.'

test('one server on every IPv4 interface', () => {
  assert.equal(
    unauthenticatedWarning(bound('0.0.0.0')),
    `WARNING: No API key is set, so anyone who can reach port 8000 on this machine (the gateway listens on every network interface) can use the MCP server. ${local}`,
  )
})

test('one server on every interface, as a dual-stack listen reports it', () => {
  assert.equal(
    unauthenticatedWarning(bound('::', 3000)),
    `WARNING: No API key is set, so anyone who can reach port 3000 on this machine (the gateway listens on every network interface) can use the MCP server. ${local}`,
  )
})

test('one server on one IPv4 address names it with the port', () => {
  assert.equal(
    unauthenticatedWarning(bound('192.168.1.5')),
    `WARNING: No API key is set, so anyone who can reach 192.168.1.5:8000 can use the MCP server. ${local}`,
  )
})

test('an IPv6 address is bracketed, as in a URL', () => {
  assert.equal(
    unauthenticatedWarning(bound('2001:db8::1')),
    `WARNING: No API key is set, so anyone who can reach [2001:db8::1]:8000 can use the MCP server. ${local}`,
  )
})

const configFix = (servers: string) =>
  `Set "apiKey" on ${servers} in the config file, --apiKey or SUPERGATEWAY_API_KEY to require a key on every server, or --host 127.0.0.1 to accept local connections only.`

test('a config file names its one server without a key', () => {
  assert.equal(
    unauthenticatedWarning(bound('::'), ['files']),
    `WARNING: No API key is set for "files", so anyone who can reach port 8000 on this machine (the gateway listens on every network interface) can use it. ${configFix('that server')}`,
  )
})

test('two servers without a key are joined with "and"', () => {
  assert.equal(
    unauthenticatedWarning(bound('10.0.0.2', 9000), ['git', 'files']),
    `WARNING: No API key is set for "git" and "files", so anyone who can reach 10.0.0.2:9000 can use them. ${configFix('those servers')}`,
  )
})

test('more servers are listed in the order the file gives them', () => {
  assert.equal(
    unauthenticatedWarning(bound('0.0.0.0'), ['c', 'a', 'b']),
    `WARNING: No API key is set for "c", "a" and "b", so anyone who can reach port 8000 on this machine (the gateway listens on every network interface) can use them. ${configFix('those servers')}`,
  )
})

// --- listenOn ---

const closeAfter = (t: { after: (fn: () => Promise<void>) => void }) => {
  const servers: Server[] = []
  t.after(async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    )
  })
  return (server: Server) => {
    servers.push(server)
    return server
  }
}

const listened = (
  host: string | undefined,
  warnUnauthenticated?: (bound: AddressInfo) => void,
) =>
  new Promise<{ server: Server; events: string[] }>((resolve) => {
    const events: string[] = []
    const server = listenOn(
      createServer(),
      {
        port: 0,
        host,
        warnUnauthenticated:
          warnUnauthenticated &&
          ((at) => {
            events.push('warned')
            warnUnauthenticated(at)
          }),
      },
      () => {
        events.push('listening')
        // The warning comes after everything the gateway lists at startup.
        setImmediate(() => resolve({ server, events }))
      },
    )
  })

test('listenOn warns once, after the startup listing, with where it bound', async (t) => {
  const track = closeAfter(t)
  const seen: AddressInfo[] = []
  const { server, events } = await listened('0.0.0.0', (at) => seen.push(at))
  track(server)
  assert.deepEqual(events, ['listening', 'warned'])
  const { port } = server.address() as AddressInfo
  assert.deepEqual(seen, [{ address: '0.0.0.0', family: 'IPv4', port }])
})

test('listenOn without a host warns about the address it bound', async (t) => {
  const track = closeAfter(t)
  const seen: AddressInfo[] = []
  const { server, events } = await listened(undefined, (at) => seen.push(at))
  track(server)
  assert.deepEqual(events, ['listening', 'warned'])
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0], server.address())
  assert.ok(['::', '0.0.0.0'].includes(seen[0].address), seen[0].address)
})

test('listenOn on loopback says nothing', async (t) => {
  const track = closeAfter(t)
  const seen: AddressInfo[] = []
  const { server, events } = await listened('127.0.0.1', (at) => seen.push(at))
  track(server)
  assert.deepEqual(events, ['listening'])
  assert.deepEqual(seen, [])
})

test('listenOn resolves a hostname before deciding', async (t) => {
  const track = closeAfter(t)
  const seen: AddressInfo[] = []
  const { server, events } = await listened('localhost', (at) => seen.push(at))
  track(server)
  assert.ok(isLoopback((server.address() as AddressInfo).address))
  assert.deepEqual(events, ['listening'])
  assert.deepEqual(seen, [])
})

test('listenOn with every server keyed never asks where it bound', async (t) => {
  const track = closeAfter(t)
  const target = createServer()
  let asked = 0
  const address = target.address.bind(target)
  target.address = () => {
    asked++
    return address()
  }
  await new Promise<void>((resolve) =>
    track(listenOn(target, { port: 0, host: '0.0.0.0' }, resolve)),
  )
  assert.equal(asked, 0)
})
