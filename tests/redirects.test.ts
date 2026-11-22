import { test } from 'node:test'
import assert from 'node:assert/strict'
import { keepsHeaders, redirectSafeFetch } from '../src/lib/redirects.js'

// What a remote server's redirects do to the request that follows them: the
// rule in redirects.ts, against a fake network, hop by hop.

interface Sent {
  url: string
  method: string
  body: unknown
  headers: Record<string, string>
  redirect: RequestRedirect | undefined
}

// A network where each URL answers as `routes` says; any other is a 200.
const network = (routes: Record<string, () => Response>) => {
  const sent: Sent[] = []
  const send = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    sent.push({
      url,
      method: init.method!,
      body: init.body,
      headers: Object.fromEntries(new Headers(init.headers)),
      redirect: init.redirect,
    })
    return routes[url]?.() ?? new Response('ok', { status: 200 })
  }) as typeof fetch
  return { send, sent }
}

const to = (status: number, location: string, body: string | null = 'moved') =>
  new Response(body, { status, headers: { location } })

const logs = () => {
  const errors: string[] = []
  return {
    errors,
    logger: { info: () => {}, error: (line: string) => errors.push(line) },
  }
}

const configured = { 'X-Api-Key': 'secret', 'x-team': 'blue' }
const request = {
  method: 'post',
  body: '{"jsonrpc":"2.0"}',
  headers: {
    'x-api-key': 'secret',
    'X-Team': 'blue',
    authorization: 'Bearer t',
    cookie: 'c=1',
    'content-type': 'application/json',
    'mcp-session-id': 's1',
  },
}

test('a response that is not a redirect is the answer, untouched', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => new Response('{}', { status: 200 }),
  })
  const { logger, errors } = logs()
  const response = await redirectSafeFetch(
    configured,
    logger,
    send,
  )('http://a.test/mcp', request)
  assert.equal(response.status, 200)
  assert.equal(response.redirected, false)
  assert.equal(sent.length, 1)
  // Every request is sent so that a redirect comes back to be decided here.
  assert.equal(sent[0].redirect, 'manual')
  assert.equal(sent[0].method, 'POST')
  assert.equal(sent[0].headers['x-api-key'], 'secret')
  assert.deepEqual(errors, [])
})

test('a redirect within the origin keeps every header and the body', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => to(307, '/v2/mcp'),
  })
  const { logger, errors } = logs()
  const response = await redirectSafeFetch(
    configured,
    logger,
    send,
  )(new URL('http://a.test/mcp'), request)
  assert.equal(response.status, 200)
  assert.equal(response.url, 'http://a.test/v2/mcp')
  assert.equal(response.redirected, true)
  assert.deepEqual(
    sent.map((s) => s.url),
    ['http://a.test/mcp', 'http://a.test/v2/mcp'],
  )
  assert.deepEqual(sent[1].headers, sent[0].headers)
  assert.equal(sent[1].method, 'POST')
  assert.equal(sent[1].body, request.body)
  assert.deepEqual(errors, [])
})

test('http to https on the same host keeps the headers', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => to(308, 'https://a.test/mcp', null),
  })
  const { logger, errors } = logs()
  await redirectSafeFetch(
    configured,
    logger,
    send,
  )('http://a.test/mcp', request)
  assert.equal(sent[1].url, 'https://a.test/mcp')
  assert.equal(sent[1].headers['x-api-key'], 'secret')
  assert.equal(sent[1].headers.authorization, 'Bearer t')
  assert.deepEqual(errors, [])
})

test('another origin gets the request without the configured headers, logged once', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => to(307, 'http://b.test/mcp'),
  })
  const { logger, errors } = logs()
  const fetch = redirectSafeFetch(configured, logger, send)
  const response = await fetch('http://a.test/mcp', request)
  assert.equal(response.url, 'http://b.test/mcp')
  assert.equal(sent[1].url, 'http://b.test/mcp')
  assert.deepEqual(sent[1].headers, {
    'content-type': 'application/json',
    'mcp-session-id': 's1',
  })
  // The body goes where the server sent it, as fetch sends it.
  assert.equal(sent[1].method, 'POST')
  assert.equal(sent[1].body, request.body)
  await fetch('http://a.test/mcp', request)
  assert.equal(sent[3].headers['x-api-key'], undefined)
  assert.deepEqual(errors, [
    'http://a.test redirected to http://b.test: following it without the configured headers',
  ])
})

test('once dropped they stay dropped, even back on the first origin', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => to(302, 'http://b.test/x'),
    'http://b.test/x': () => to(302, 'http://a.test/back'),
  })
  const { logger, errors } = logs()
  await redirectSafeFetch(
    configured,
    logger,
    send,
  )('http://a.test/mcp', {
    headers: request.headers,
  })
  assert.equal(sent[2].url, 'http://a.test/back')
  assert.equal(sent[2].headers['x-api-key'], undefined)
  assert.equal(errors.length, 1)
})

test('another origin is not logged when there was nothing to drop', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => to(307, 'http://b.test/mcp'),
  })
  const { logger, errors } = logs()
  await redirectSafeFetch(
    {},
    logger,
    send,
  )('http://a.test/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  })
  assert.equal(sent[1].url, 'http://b.test/mcp')
  assert.deepEqual(errors, [])
})

test('Authorization and Cookie are dropped across origins even when not configured', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => to(307, 'http://b.test/mcp'),
  })
  const { logger, errors } = logs()
  await redirectSafeFetch(
    {},
    logger,
    send,
  )('http://a.test/mcp', {
    headers: { authorization: 'Bearer t', cookie: 'c=1' },
  })
  assert.deepEqual(sent[1].headers, {})
  assert.equal(errors.length, 1)
})

test('which redirects may carry the configured headers', () => {
  const keeps = (from: string, to: string) =>
    keepsHeaders(new URL(from), new URL(to))
  assert.equal(keeps('http://a.test/x', 'http://a.test/y'), true)
  assert.equal(keeps('https://a.test:8443/x', 'https://a.test:8443/y'), true)
  assert.equal(keeps('http://a.test/x', 'https://a.test/x'), true)
  // Each of these differs from the upgrade in one thing.
  assert.equal(keeps('https://a.test/x', 'http://a.test/x'), false)
  assert.equal(keeps('http://a.test/x', 'http://b.test/x'), false)
  assert.equal(keeps('http://a.test/x', 'https://b.test/x'), false)
  assert.equal(keeps('http://a.test:8080/x', 'https://a.test/x'), false)
  assert.equal(keeps('http://a.test/x', 'https://a.test:8443/x'), false)
  assert.equal(keeps('http://a.test/x', 'http://a.test:81/x'), false)
})

// fetch's own rules for what a redirect does to the method and the body.
for (const [status, method, after] of [
  [303, 'POST', 'GET'],
  [303, 'PUT', 'GET'],
  [303, 'GET', 'GET'],
  [303, 'HEAD', 'HEAD'],
  [301, 'POST', 'GET'],
  [302, 'POST', 'GET'],
  [302, 'PUT', 'PUT'],
  [301, 'GET', 'GET'],
  [307, 'POST', 'POST'],
  [308, 'POST', 'POST'],
] as const)
  test(`${status} after ${method} is followed with ${after}`, async () => {
    const { send, sent } = network({
      'http://a.test/mcp': () => to(status, '/next'),
    })
    const { logger } = logs()
    const body = method === 'GET' || method === 'HEAD' ? undefined : 'data'
    await redirectSafeFetch(
      configured,
      logger,
      send,
    )('http://a.test/mcp', {
      method,
      body,
      headers: { 'content-type': 'application/json', 'x-api-key': 'secret' },
    })
    assert.equal(sent[1].method, after)
    const changed = after !== method
    assert.equal(sent[1].body, changed ? undefined : body)
    assert.equal(
      sent[1].headers['content-type'],
      changed ? undefined : 'application/json',
    )
    assert.equal(sent[1].headers['x-api-key'], 'secret')
  })

test('without a method it is a GET', async () => {
  const { send, sent } = network({})
  const { logger } = logs()
  await redirectSafeFetch(configured, logger, send)('http://a.test/mcp')
  assert.equal(sent[0].method, 'GET')
  assert.deepEqual(sent[0].headers, {})
})

test('a redirect status without a Location is the answer', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => new Response('gone', { status: 301 }),
  })
  const { logger } = logs()
  const response = await redirectSafeFetch(
    configured,
    logger,
    send,
  )('http://a.test/mcp')
  assert.equal(response.status, 301)
  assert.equal(await response.text(), 'gone')
  assert.equal(sent.length, 1)
})

test('a 304 with a Location is not a redirect', async () => {
  const { send, sent } = network({
    'http://a.test/mcp': () => to(304, '/elsewhere', null),
  })
  const { logger } = logs()
  const response = await redirectSafeFetch(
    configured,
    logger,
    send,
  )('http://a.test/mcp')
  assert.equal(response.status, 304)
  assert.equal(sent.length, 1)
})

test('twenty redirects are followed, and the twenty-first fails', async () => {
  const loop = (limit: number) =>
    network(
      Object.fromEntries(
        Array.from({ length: limit }, (_, i) => [
          `http://a.test/${i}`,
          () => to(307, `/${i + 1}`),
        ]),
      ),
    )
  const { logger } = logs()
  const twenty = loop(20)
  const response = await redirectSafeFetch(
    configured,
    logger,
    twenty.send,
  )('http://a.test/0')
  assert.equal(response.url, 'http://a.test/20')
  assert.equal(twenty.sent.length, 21)

  const endless = loop(100)
  await assert.rejects(
    redirectSafeFetch(configured, logger, endless.send)('http://a.test/0'),
    { name: 'TypeError', message: 'Too many redirects from http://a.test/0' },
  )
  assert.equal(endless.sent.length, 21)
})
