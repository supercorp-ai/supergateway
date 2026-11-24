import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import {
  corsAllows,
  crossSiteRefusal,
  hostnameOf,
  localName,
  onLoopback,
  rebindingLog,
  rebindingRefusal,
  refuseRebinding,
} from '../src/lib/browserGuard.js'

const request = (
  headers: Record<string, string>,
  ...address: [string | undefined] | []
) =>
  ({
    headers,
    socket: { localAddress: address.length ? address[0] : '127.0.0.1' },
  }) as unknown as IncomingMessage

// What a browser sends for a same-origin request from a page at `name`.
const sameOrigin = (name: string, extra: Record<string, string> = {}) => ({
  host: `${name}:8000`,
  'sec-fetch-site': 'same-origin',
  ...extra,
})

test('a connection is loopback on 127/8, ::1 and IPv4-mapped 127/8 only', () => {
  for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])
    assert.equal(onLoopback(request({}, address)), true, address)
  for (const address of [
    '192.168.1.5',
    '::ffff:10.0.0.2',
    '2001:db8::1',
    '',
    undefined,
  ])
    assert.equal(onLoopback(request({}, address)), false, String(address))
})

test('names only this machine answers to: localhost, *.localhost and addresses', () => {
  for (const name of [
    'localhost',
    'app.localhost',
    '127.0.0.1',
    '192.168.1.5',
    '[::1]',
    '[2001:db8::1]',
  ])
    assert.equal(localName(name), true, name)
  for (const name of [
    'evil.example',
    'abc.ngrok-free.app',
    'localhost.evil.example',
    'mymac.local',
  ])
    assert.equal(localName(name), false, name)
})

test('the host name of a Host header or an origin', () => {
  assert.equal(hostnameOf('Evil.Example:8000'), 'evil.example')
  assert.equal(hostnameOf('https://app.example'), 'app.example')
  assert.equal(hostnameOf('[::1]:8000'), '[::1]')
  assert.equal(hostnameOf(undefined), undefined)
  assert.equal(hostnameOf(''), undefined)
  assert.equal(hostnameOf('http://exa mple'), undefined)
})

test('--cors allows an origin as the cors package does', () => {
  assert.equal(corsAllows('*', 'http://a.example'), true)
  assert.equal(corsAllows(true, 'http://a.example'), true)
  assert.equal(corsAllows(false, 'http://a.example'), false)
  assert.equal(corsAllows(undefined, 'http://a.example'), false)
  const listed = ['http://a.example', /^https:\/\/[a-z]+\.b\.example$/]
  assert.equal(corsAllows(listed, 'http://a.example'), true)
  assert.equal(corsAllows(listed, 'https://x.b.example'), true)
  assert.equal(corsAllows(listed, 'http://c.example'), false)
})

test('DNS rebinding: a same-origin browser request for a name of its own, on loopback, is refused', () => {
  assert.equal(
    rebindingRefusal(request(sameOrigin('evil.example')), { cors: false }),
    'evil.example',
  )
  // Told by Origin alone, as a browser without Sec-Fetch-Site does on a POST.
  assert.equal(
    rebindingRefusal(
      request({
        host: 'evil.example:8000',
        origin: 'http://evil.example:8000',
      }),
      { cors: false },
    ),
    'evil.example',
  )
})

test('DNS rebinding: everything that only looks similar passes', () => {
  const passes = (
    req: IncomingMessage,
    options: Parameters<typeof rebindingRefusal>[1] = { cors: false },
  ) => assert.equal(rebindingRefusal(req, options), undefined)
  // Not loopback: LAN, Docker and remote traffic.
  passes(request(sameOrigin('evil.example'), '192.168.1.5'))
  // A client that is not a browser, through a tunnel that forwards its Host.
  passes(request({ host: 'abc.ngrok-free.app' }))
  // A page on this machine's own names.
  passes(request(sameOrigin('localhost')))
  passes(request(sameOrigin('127.0.0.1')))
  // No Host at all, or one that isn't a name.
  passes(request({ 'sec-fetch-site': 'same-origin' }))
  passes(request({ host: 'exa mple', 'sec-fetch-site': 'same-origin' }))
  // A cross-origin page: CORS already decides those.
  passes(
    request({
      host: 'evil.example:8000',
      'sec-fetch-site': 'cross-site',
      origin: 'http://other.example',
    }),
  )
  // The page the gateway is served for, named by --baseUrl or --cors.
  passes(request(sameOrigin('mcp.example')), {
    cors: false,
    baseUrl: 'https://mcp.example/',
  })
  passes(
    request(sameOrigin('mcp.example', { origin: 'https://mcp.example' })),
    { cors: ['https://mcp.example'] },
  )
  passes(request(sameOrigin('mcp.example')), {
    cors: ['https://mcp.example:8000'],
  })
  passes(request(sameOrigin('mcp.example')), { cors: '*' })
  // --baseUrl or --cors for another name allow nothing here.
  assert.equal(
    rebindingRefusal(request(sameOrigin('evil.example')), {
      cors: ['https://mcp.example'],
      baseUrl: 'https://mcp.example',
    }),
    'evil.example',
  )
})

const logger = () => {
  const lines: string[] = []
  return {
    lines,
    logger: {
      info: (line: string) => lines.push(line),
      error() {},
      debug() {},
      warn() {},
    },
  }
}

const respond = () => {
  const sent: { status?: number; type?: string; body?: string; next: boolean } =
    { next: false }
  const res = {
    status(code: number) {
      sent.status = code
      return res
    },
    type(value: string) {
      sent.type = value
      return res
    },
    send(body: string) {
      sent.body = body
    },
  }
  return { res, sent, next: () => (sent.next = true) }
}

test('the HTTP check answers 403 and logs each name once, naming --baseUrl only for SSE', () => {
  const { lines, logger: log } = logger()
  const check = refuseRebinding({
    cors: false,
    apiKeys: [],
    logger: log as any,
  })
  for (let i = 0; i < 2; i++) {
    const { res, sent, next } = respond()
    check(request(sameOrigin('evil.example')) as any, res as any, next)
    assert.equal(sent.status, 403)
    assert.equal(sent.type, 'application/json')
    assert.deepEqual(JSON.parse(sent.body!), {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Forbidden: host not allowed' },
      id: null,
    })
    assert.equal(sent.next, false)
  }
  assert.deepEqual(lines, [rebindingLog('evil.example')])
  assert.doesNotMatch(lines[0], /--baseUrl/)
  assert.match(
    rebindingLog('evil.example', true),
    /add --baseUrl https:\/\/evil\.example or --cors/,
  )

  const sse = logger()
  const { res, next } = respond()
  refuseRebinding({
    cors: false,
    baseUrl: '',
    apiKeys: [],
    logger: sse.logger as any,
  })(request(sameOrigin('evil.example')) as any, res as any, next)
  assert.deepEqual(sse.lines, [rebindingLog('evil.example', true)])
})

test('the HTTP check lets everything else through, and does nothing when a key is set', () => {
  const { lines, logger: log } = logger()
  for (const [apiKeys, req] of [
    [[], request({ host: 'localhost:8000', 'sec-fetch-site': 'same-origin' })],
    [['k'], request(sameOrigin('evil.example'))],
  ] as const) {
    const { res, sent, next } = respond()
    refuseRebinding({ cors: false, apiKeys: [...apiKeys], logger: log as any })(
      req as any,
      res as any,
      next,
    )
    assert.equal(sent.next, true)
    assert.equal(sent.status, undefined)
  }
  assert.deepEqual(lines, [])
})

test('WebSocket from another site, on loopback, is refused; every other kind passes', () => {
  const refused = (
    origin: string | undefined,
    host = '127.0.0.1:8000',
    address = '127.0.0.1',
  ) =>
    crossSiteRefusal(
      request(origin === undefined ? { host } : { host, origin }, address),
    )
  assert.equal(refused('https://evil.example'), true)
  assert.equal(refused('null'), true)
  assert.equal(refused('http://exa mple'), true)
  // No Origin: every client that is not a browser.
  assert.equal(refused(undefined), false)
  // Pages on this machine, extensions, and the gateway's own name.
  for (const origin of [
    'http://localhost:3000',
    'http://app.localhost:5173',
    'http://127.0.0.1:8080',
    'http://[::1]:3000',
    'chrome-extension://abc',
    'moz-extension://abc',
    'safari-web-extension://abc',
    'ms-browser-extension://abc',
  ])
    assert.equal(refused(origin), false, origin)
  assert.equal(refused('https://mcp.example', 'mcp.example'), false)
  // Not loopback: a gateway other machines use.
  assert.equal(
    refused('https://evil.example', '192.168.1.5:8000', '192.168.1.5'),
    false,
  )
})
