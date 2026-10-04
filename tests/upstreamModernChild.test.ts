import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  MODERN_VERSION,
  SPEAKS_FOR_MS,
  UpstreamModernChild,
  remoteSpeaksModern,
} from '../src/lib/upstreamModernChild.js'
import { encodedHeader, mirroredHeaders } from '../src/lib/modernHeaders.js'

// A remote server as the 2026-07-28 relay's server for one request, with
// `fetch` replaced: what it is sent, and what is made of its answers.

const remote = {
  url: new URL('http://remote.example/mcp'),
  type: 'streamableHttp' as const,
  headers: { authorization: 'Bearer upstream', 'x-team': 'core' },
}

const logs = () => {
  const info: string[] = []
  const errors: unknown[][] = []
  return {
    info,
    errors,
    logger: {
      info: (line: string) => info.push(line),
      error: (...args: unknown[]) => errors.push(args),
    },
  }
}

type Sent = {
  url: string
  init: RequestInit & { headers: Record<string, string> }
}

// Replaces fetch with `answer`, and records what was sent.
const fetched = (
  t: TestContext,
  answer: (sent: Sent) => Response | Promise<Response>,
) => {
  const sent: Sent[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL, init: Sent['init']) => {
    const request = { url: String(url), init }
    sent.push(request)
    return answer(request)
  })
  return sent
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

// An event stream delivered in the chunks given.
const stream = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  )

const child = (params: Record<string, string> = {}) => {
  const { logger, errors } = logs()
  const upstream = new UpstreamModernChild(
    remote,
    { version: MODERN_VERSION, params },
    logger,
  )
  const messages: unknown[] = []
  const failures: string[] = []
  let closes = 0
  upstream.onmessage = (message) => messages.push(message)
  upstream.onerror = (error) => failures.push(error.message)
  upstream.onclose = () => closes++
  return { upstream, messages, failures, errors, closes: () => closes }
}

const call = (name: string, id: string | number = 7) => ({
  jsonrpc: '2.0' as const,
  id,
  method: 'tools/call',
  params: { name, arguments: { value: 'hi' } },
})

test("a request is a POST with the headers that mirror it, and the gateway's own for the remote server", async (t) => {
  const sent = fetched(t, () =>
    json({ jsonrpc: '2.0', id: 7, result: { ok: true } }),
  )
  const { upstream, messages } = child({ 'mcp-param-value': 'hi' })
  await upstream.start()
  await upstream.send(call('echo'))
  await upstream.finish()
  assert.equal(sent[0].url, 'http://remote.example/mcp')
  assert.equal(sent[0].init.method, 'POST')
  assert.deepEqual(sent[0].init.headers, {
    authorization: 'Bearer upstream',
    'x-team': 'core',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'tools/call',
    'mcp-name': 'echo',
    'mcp-param-value': 'hi',
  })
  assert.deepEqual(JSON.parse(sent[0].init.body as string), call('echo'))
  assert.deepEqual(messages, [{ jsonrpc: '2.0', id: 7, result: { ok: true } }])
})

test('the argument mirrors go with a tool call only; a request with no declared version sends none', async (t) => {
  const sent = fetched(t, (request) =>
    json({
      jsonrpc: '2.0',
      id: JSON.parse(request.init.body as string).id,
      result: {},
    }),
  )
  const { upstream } = child({ 'mcp-param-value': 'hi' })
  await upstream.send({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
    params: {},
  })
  assert.equal('mcp-param-value' in sent[0].init.headers, false)
  assert.equal('mcp-name' in sent[0].init.headers, false)

  const { logger } = logs()
  const unversioned = new UpstreamModernChild(
    remote,
    { version: undefined, params: {} },
    logger,
  )
  await unversioned.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  assert.equal('mcp-protocol-version' in sent[1].init.headers, false)
})

test('an event stream is delivered message by message, however it is cut', async (t) => {
  const progress = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progress: 1 },
  }
  const reply = { jsonrpc: '2.0', id: 7, result: { content: [] } }
  fetched(t, () =>
    stream([
      `: a comment\n\nevent: message\nid: 1\ndata: ${JSON.stringify(progress)}\n`,
      `\ndata: {"jsonrpc":"2.0","id":7,\r\ndata: "result":{"content":[]}}\r\n\r\nretry: 5\n\n`,
    ]),
  )
  const { upstream, messages, failures } = child()
  await upstream.send(call('wait'))
  await upstream.finish()
  assert.deepEqual(messages, [progress, reply])
  assert.deepEqual(failures, [])
})

test('the stream is read no faster than the client reads', async (t) => {
  const one = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progress: 1 },
  }
  const reply = { jsonrpc: '2.0', id: 7, result: {} }
  fetched(t, () =>
    stream([
      `data: ${JSON.stringify(one)}\n\n`,
      `data: ${JSON.stringify(reply)}\n\n`,
    ]),
  )
  const { upstream, messages } = child()
  let release!: () => void
  upstream.onmessage = (message) => {
    messages.push(message)
    // The client is behind after the first: hold the rest.
    if (messages.length === 1)
      upstream.hold(new Promise<void>((resolve) => (release = resolve)))
  }
  await upstream.send(call('wait'))
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.deepEqual(messages, [one])
  upstream.hold(undefined)
  release()
  await upstream.finish()
  assert.deepEqual(messages, [one, reply])
})

test('an error the remote server answers with is its answer, whatever the status', async (t) => {
  const refused = {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32601, message: 'no such method' },
  }
  fetched(t, () => json(refused, 404))
  const { upstream, messages, failures } = child()
  await upstream.send(call('x'))
  await upstream.finish()
  assert.deepEqual(messages, [refused])
  assert.deepEqual(failures, [])
})

test('an answer that is no reply fails the request, once', async (t) => {
  const cases: [string, () => Response, string][] = [
    [
      'a status with no JSON',
      () => new Response('nope', { status: 502 }),
      'The remote server answered 502',
    ],
    [
      'nothing at all',
      () => new Response(null, { status: 202 }),
      'The remote server ended its answer without a reply',
    ],
    [
      'a stream that ends first',
      () =>
        stream([
          'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n',
        ]),
      'The remote server ended its answer without a reply',
    ],
    [
      'an answer to something else',
      () => json({ jsonrpc: '2.0', id: 'other', result: {} }),
      'The remote server ended its answer without a reply',
    ],
    ['a body that is not JSON-RPC', () => json({ hello: 'world' }), ''],
  ]
  for (const [name, answer, message] of cases) {
    fetched(t, answer)
    const { upstream, failures, errors, closes } = child()
    await upstream.send(call('x'))
    await upstream.finish()
    assert.equal(failures.length, 1, name)
    if (message) assert.equal(failures[0], message, name)
    assert.equal(errors[0][0], 'Upstream request failed:', name)
    assert.equal(closes(), 1, name)
    await upstream.close()
    assert.equal(closes(), 1, `${name}: closed once`)
    t.mock.restoreAll()
  }
})

test('a notification needs no answer', async (t) => {
  const sent = fetched(t, () => new Response(null, { status: 202 }))
  const { upstream, messages, failures } = child()
  await upstream.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 7 },
  })
  await upstream.finish()
  assert.equal(sent[0].init.headers['mcp-method'], 'notifications/cancelled')
  assert.deepEqual(messages, [])
  assert.deepEqual(failures, [])
})

test('closing aborts what is under way, and nothing more is sent or reported', async (t) => {
  let aborted = false
  fetched(
    t,
    ({ init }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener('abort', () => {
          aborted = true
          reject(new DOMException('aborted', 'AbortError'))
        })
      }),
  )
  const { upstream, failures, closes } = child()
  const sending = upstream.send(call('slow'))
  await upstream.close()
  await assert.rejects(sending, /aborted/)
  assert.equal(aborted, true)
  assert.equal(closes(), 1)
  assert.deepEqual(failures, [])
  await assert.rejects(
    upstream.send(call('late')),
    /Upstream request is closed/,
  )
})

test('a stream cut off after closing is not a failure', async (t) => {
  let cut!: () => void
  fetched(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            cut = () => controller.error(Error('socket hang up'))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  )
  const { upstream, failures, errors } = child()
  await upstream.send(call('slow'))
  await upstream.close()
  cut()
  await upstream.finish()
  assert.deepEqual(failures, [])
  assert.deepEqual(errors, [])
})

test('headers carry plain ASCII as it is, and anything else encoded', () => {
  assert.equal(encodedHeader('tools/call'), 'tools/call')
  assert.equal(encodedHeader('with space inside'), 'with space inside')
  for (const value of [
    '',
    ' leading',
    'trailing ',
    'naïve',
    'line\nbreak',
    '=?base64?aGk=?=',
  ])
    assert.equal(
      encodedHeader(value),
      `=?base64?${Buffer.from(value).toString('base64')}?=`,
      JSON.stringify(value),
    )
})

test('the mirrors of a message: its method, and the name it is for', () => {
  assert.deepEqual(mirroredHeaders({ jsonrpc: '2.0', id: 1, result: {} }), {})
  assert.deepEqual(
    mirroredHeaders({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    { 'mcp-method': 'tools/list' },
  )
  assert.deepEqual(
    mirroredHeaders({
      jsonrpc: '2.0',
      id: 1,
      method: 'prompts/get',
      params: { name: 'grüß' },
    }),
    { 'mcp-method': 'prompts/get', 'mcp-name': '=?base64?Z3LDvMOf?=' },
  )
  assert.deepEqual(
    mirroredHeaders({
      jsonrpc: '2.0',
      id: 1,
      method: 'resources/read',
      params: { uri: 'note://a' },
    }),
    { 'mcp-method': 'resources/read', 'mcp-name': 'note://a' },
  )
  // A name that is no string has no mirror.
  assert.deepEqual(
    mirroredHeaders({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 7 },
    } as never),
    { 'mcp-method': 'tools/call' },
  )
})

// --- Whether the remote server speaks it ---

const discovered = (versions: unknown, status = 200) =>
  json(
    {
      jsonrpc: '2.0',
      id: 'supergateway-discover',
      result: { supportedVersions: versions },
    },
    status,
  )

test('a remote server that lists the version among those it supports speaks it', async (t) => {
  const sent = fetched(t, () => discovered(['2025-11-25', MODERN_VERSION]))
  const { logger, info } = logs()
  const speaks = remoteSpeaksModern(remote, logger)
  assert.equal(await speaks(), true)
  assert.deepEqual(info, ['The remote server speaks 2026-07-28'])
  const { headers, body } = sent[0].init
  assert.deepEqual(headers, {
    authorization: 'Bearer upstream',
    'x-team': 'core',
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': 'server/discover',
  })
  const request = JSON.parse(body as string)
  assert.equal(request.method, 'server/discover')
  assert.equal(
    request.params._meta['io.modelcontextprotocol/protocolVersion'],
    MODERN_VERSION,
  )
  assert.equal(
    request.params._meta['io.modelcontextprotocol/clientInfo'].name,
    'supergateway',
  )
})

test('the answer may come as an event stream', async (t) => {
  fetched(t, () =>
    stream([
      `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 'supergateway-discover', result: { supportedVersions: [MODERN_VERSION] } })}\n\n`,
    ]),
  )
  assert.equal(await remoteSpeaksModern(remote, logs().logger)(), true)
})

test('anything else is a server that does not speak it', async (t) => {
  const answers: [string, () => Response | Promise<Response>][] = [
    ['other versions', () => discovered(['2025-11-25'])],
    [
      'an error',
      () =>
        json(
          {
            jsonrpc: '2.0',
            id: null,
            error: { code: -32000, message: 'Unsupported protocol version' },
          },
          400,
        ),
    ],
    ['the version, but not OK', () => discovered([MODERN_VERSION], 500)],
    ['no versions', () => json({ jsonrpc: '2.0', id: 1, result: {} })],
    ['not JSON', () => new Response('<html>', { status: 200 })],
    ['an empty stream', () => stream([': nothing\n\n'])],
    ['no answer', () => Promise.reject(TypeError('fetch failed'))],
  ]
  for (const [name, answer] of answers) {
    fetched(t, answer)
    const { logger, info } = logs()
    assert.equal(await remoteSpeaksModern(remote, logger)(), false, name)
    assert.deepEqual(
      info,
      ['The remote server does not speak 2026-07-28'],
      name,
    )
    t.mock.restoreAll()
  }
})

test('the answer stands for a minute, and one question is asked at a time', async (t) => {
  let now = 1000
  let versions = [MODERN_VERSION]
  const sent = fetched(t, () => discovered(versions))
  const speaks = remoteSpeaksModern(remote, logs().logger, () => now)
  assert.deepEqual(await Promise.all([speaks(), speaks()]), [true, true])
  assert.equal(sent.length, 1)
  versions = []
  now += SPEAKS_FOR_MS - 1
  assert.equal(await speaks(), true)
  assert.equal(sent.length, 1)
  now += 1
  assert.equal(await speaks(), false)
  assert.equal(sent.length, 2)
})

test('a message that is no request, or an answer cut mid-event, is handled like any other', async (t) => {
  const reply = { jsonrpc: '2.0', id: 7, result: {} }
  // The first chunk holds no whole event.
  const sent = fetched(t, () =>
    stream(['data: {"jsonrpc":"2.0",', `"id":7,"result":{}}\n\n`]),
  )
  const { upstream, messages, failures } = child({ 'mcp-param-value': 'x' })
  await upstream.send(call('wait'))
  await upstream.finish()
  assert.deepEqual(messages, [reply])

  // A response of the client's own: posted, with no mirrors, and no answer
  // is waited for.
  t.mock.restoreAll()
  const answered = fetched(t, () => new Response(null, { status: 202 }))
  await upstream.send({ jsonrpc: '2.0', id: 3, result: { roots: [] } })
  await upstream.finish()
  assert.equal('mcp-method' in answered[0].init.headers, false)
  assert.equal('mcp-param-value' in answered[0].init.headers, false)
  assert.deepEqual(failures, [])
  assert.equal(sent.length, 1)
})

test("a request of the server's under the same id is no answer to it", async (t) => {
  fetched(t, () =>
    stream(['data: {"jsonrpc":"2.0","id":7,"method":"roots/list"}\n\n']),
  )
  const { upstream, messages, failures } = child()
  await upstream.send(call('x'))
  await upstream.finish()
  assert.equal(messages.length, 1)
  assert.deepEqual(failures, [
    'The remote server ended its answer without a reply',
  ])
})

test('a failure with no one to tell still closes the request', async (t) => {
  fetched(t, () => new Response('nope', { status: 502 }))
  const { logger, errors } = logs()
  const upstream = new UpstreamModernChild(
    remote,
    { version: MODERN_VERSION, params: {} },
    logger,
  )
  await upstream.send(call('x'))
  await upstream.finish()
  assert.equal(errors.length, 1)
  await assert.rejects(upstream.send(call('y')), /Upstream request is closed/)
})

test('an answer with no body at all is a server that does not speak it', async (t) => {
  fetched(t, () => new Response(null, { status: 200 }))
  assert.equal(await remoteSpeaksModern(remote, logs().logger)(), false)
})
