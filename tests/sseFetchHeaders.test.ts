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
  // The event source owns this call. It may pass its own request init, and it
  // may equally call fetch with the URL alone.
  await wrapped('http://127.0.0.1:54321/events', {
    headers: { Accept: 'text/event-stream' },
    cache: 'no-store',
  })
  await wrapped('http://127.0.0.1:54321/events')
  fetchMock.mock.restore()
  // map: headers-merged-over-supplied-init
  assert.deepEqual(
    calls[0].init,
    {
      headers: { Accept: 'text/event-stream', ...headers },
      cache: 'no-store',
    },
    'supplied init is preserved and the configured headers are merged on top of its own',
  )
  // map: headers-applied-without-init
  assert.deepEqual(
    calls[1].init,
    { headers },
    'a call with no init still carries the configured headers rather than sending none',
  )
})
