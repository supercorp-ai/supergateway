import { test } from 'node:test'
import assert from 'node:assert/strict'

test('SSE bridge applies configured headers whether or not the event source supplies request init', async (t) => {
  const remotes: any[] = []
  t.mock.module('@modelcontextprotocol/sdk/client/index.js', {
    namedExports: { Client: class {} },
  })
  t.mock.module('@modelcontextprotocol/sdk/client/sse.js', {
    namedExports: {
      SSEClientTransport: class {
        constructor(
          public url: URL,
          public options: any,
        ) {
          remotes.push(this)
        }
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/index.js', {
    namedExports: {
      Server: class {
        transport: any
        async connect(transport: any) {
          this.transport = transport
        }
      },
    },
  })
  t.mock.module('@modelcontextprotocol/sdk/server/stdio.js', {
    namedExports: { StdioServerTransport: class {} },
  })
  t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
    namedExports: { onSignals() {} },
  })
  const calls: any[] = []
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async (url: any, init: any) => {
      calls.push({ url, init })
      return new globalThis.Response('', { status: 200 })
    },
  )
  const headers = { Authorization: 'Bearer configured', 'X-Trace': 'sse' }
  const { sseToStdio } = await import('../src/gateways/sseToStdio.js')
  await sseToStdio({
    sseUrl: 'http://127.0.0.1:54321/events',
    logger: { info() {}, error() {} },
    headers,
  })
  const wrapped = remotes[0].options.eventSourceInit.fetch
  // The event source owns this call. The SDK passes a `Headers` object, but a
  // caller may pass a plain object, or call fetch with the URL alone.
  await wrapped('http://127.0.0.1:54321/events', {
    headers: new Headers({
      Accept: 'text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      'X-Trace': 'from the sdk',
    }),
    cache: 'no-store',
  })
  await wrapped('http://127.0.0.1:54321/events', {
    headers: { Accept: 'text/event-stream' },
  })
  await wrapped('http://127.0.0.1:54321/events')
  fetchMock.mock.restore()
  const sent = (call: { init: { headers: Headers } }) =>
    Object.fromEntries(call.init.headers)
  // map: headers-merged-over-supplied-init
  // Spreading a `Headers` object yields `{}`, so the SDK's own headers used to
  // vanish: the stream request went out as `Accept: */*`.
  assert.deepEqual(
    sent(calls[0]),
    {
      accept: 'text/event-stream',
      'mcp-protocol-version': '2025-06-18',
      authorization: 'Bearer configured',
      'x-trace': 'sse',
    },
    'the SDK’s headers survive, and a configured header wins over its own',
  )
  assert.equal(calls[0].init.cache, 'no-store', 'the rest of init is kept')
  assert.deepEqual(sent(calls[1]), {
    accept: 'text/event-stream',
    authorization: 'Bearer configured',
    'x-trace': 'sse',
  })
  // map: headers-applied-without-init
  assert.deepEqual(
    sent(calls[2]),
    { authorization: 'Bearer configured', 'x-trace': 'sse' },
    'a call with no init still carries the configured headers rather than sending none',
  )
})
