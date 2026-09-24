import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  absolutizeSseEndpoint,
  sseEndpointOrigin,
} from '../src/lib/sseEndpointOrigin.js'

// #46. The endpoint becomes absolute only on evidence that this client
// connected through `--baseUrl`'s own origin; on anything less it stays
// relative, which is exactly what every release since SDK 1.9 has sent.
const origin = (baseUrl: string, headers: Record<string, string>) =>
  sseEndpointOrigin(baseUrl, headers)

test('an absolute endpoint needs a --baseUrl that parses to http(s)', () => {
  const host = { host: 'pub.example' }
  assert.equal(origin('', host), undefined, 'no --baseUrl')
  assert.equal(origin('not a url', host), undefined, 'not a URL')
  assert.equal(origin('ftp://pub.example', host), undefined, 'not http(s)')
  assert.equal(origin('http://pub.example', host), 'http://pub.example')
})

test('a --baseUrl no hosted client could reach never becomes absolute', () => {
  // Each of these matches the request's Host, which a proxy rewriting Host to
  // its upstream would produce for a client that connected somewhere else.
  for (const [baseUrl, host] of [
    ['http://localhost:8000', 'localhost:8000'],
    ['http://127.0.0.1:8000', '127.0.0.1:8000'],
    ['http://10.1.2.3:8000', '10.1.2.3:8000'],
    ['http://192.168.1.5', '192.168.1.5'],
    ['http://[::1]:8000', '[::1]:8000'],
    ['http://[fc00::1]:8000', '[fc00::1]:8000'],
    ['http://gateway:8000', 'gateway:8000'],
    ['http://mcp.internal', 'mcp.internal'],
    ['http://box.local', 'box.local'],
  ]) {
    assert.equal(origin(baseUrl, { host }), undefined, baseUrl)
  }
  // Public names and addresses, of either family, are eligible.
  assert.equal(
    origin('http://203.0.113.5:8000', { host: '203.0.113.5:8000' }),
    'http://203.0.113.5:8000',
  )
  assert.equal(
    origin('http://[2001:db8::1]:8000', { host: '[2001:db8::1]:8000' }),
    'http://[2001:db8::1]:8000',
  )
})

test('the client must have connected through that same origin', () => {
  const base = 'https://pub.example/gateway'
  const proxied = { 'x-forwarded-proto': 'https' }
  assert.equal(origin(base, {}), undefined, 'no Host at all')
  assert.equal(
    origin(base, { ...proxied, host: 'other.example' }),
    undefined,
    'another host',
  )
  assert.equal(
    origin(base, { host: 'pub.example' }),
    undefined,
    'no proxy said https, and the gateway itself only serves http',
  )
  assert.equal(
    origin(base, { host: 'pub.example', 'x-forwarded-proto': 'http' }),
    undefined,
    'a proxy that says http',
  )
  assert.equal(
    origin(base, { host: 'pub.example', 'x-forwarded-proto': 'HTTPS' }),
    'https://pub.example',
  )
})

test("a proxy's X-Forwarded-Host speaks for the client", () => {
  const base = 'https://pub.example'
  // nginx and friends: Host is the upstream, the forwarded host is the client's.
  assert.equal(
    origin(base, {
      host: '127.0.0.1:8000',
      'x-forwarded-host': 'pub.example',
      'x-forwarded-proto': 'https',
    }),
    'https://pub.example',
  )
  // A chain appends: the first value is the one the client sent.
  assert.equal(
    origin(base, {
      host: '127.0.0.1:8000',
      'x-forwarded-host': 'pub.example, edge.internal',
      'x-forwarded-proto': 'https, http',
    }),
    'https://pub.example',
  )
  // An empty forwarded host says nothing, so Host decides.
  assert.equal(
    origin(base, {
      host: 'pub.example',
      'x-forwarded-host': '',
      'x-forwarded-proto': 'https',
    }),
    'https://pub.example',
  )
})

test('the origin repeats the authority exactly as the client sent it', () => {
  // The Python client compares netlocs as literal strings, so `pub.example`
  // and `pub.example:443` must not be exchanged for one another.
  const proxied = { 'x-forwarded-proto': 'https' }
  assert.equal(
    origin('https://pub.example', { ...proxied, host: 'pub.example:443' }),
    'https://pub.example:443',
  )
  assert.equal(
    origin('https://pub.example:443', { ...proxied, host: 'pub.example' }),
    'https://pub.example',
  )
  assert.equal(
    origin('http://pub.example:8080', { host: 'pub.example:8081' }),
    undefined,
    'a different port is a different origin',
  )
})

test('the endpoint event gets the origin; nothing else is touched', () => {
  const writes: unknown[] = []
  const res: any = {
    write(chunk: unknown) {
      writes.push(chunk)
      return true
    },
  }
  const original = res.write
  absolutizeSseEndpoint(res, 'https://pub.example')
  res.write('event: endpoint\ndata: /gateway/message?sessionId=abc\n\n')
  assert.equal(res.write, original, 'it rewrites one write, then steps aside')
  res.write('event: message\ndata: {"jsonrpc":"2.0"}\n\n')
  assert.deepEqual(writes, [
    'event: endpoint\ndata: https://pub.example/gateway/message?sessionId=abc\n\n',
    'event: message\ndata: {"jsonrpc":"2.0"}\n\n',
  ])

  // If an SDK ever wrote something else first, it passes through untouched.
  const passed: unknown[] = []
  const other: any = {
    write(chunk: unknown) {
      passed.push(chunk)
      return true
    },
  }
  absolutizeSseEndpoint(other, 'https://pub.example')
  const bytes = Buffer.from(': comment\n\n')
  other.write(bytes)
  assert.deepEqual(passed, [bytes])
})
