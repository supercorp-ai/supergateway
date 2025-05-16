import { test } from 'node:test'
import assert from 'node:assert/strict'

test('logs the first endpoint SSE', { timeout: 10_000 }, async (t) => {
  console.log({
    t,
    mock: t.mock,
    mod: t.mock.module,
  })

  // @ts-ignore
  const endpointSpy = t.mock.fn<[MessageEvent], void>()

  const { EventSource: RealES } = await import('eventsource')

  class TappableES extends RealES {
    constructor(url: string | URL, init?: EventSourceInit) {
      super(url as any, init)
      // @ts-ignore
      this.addEventListener('endpoint', endpointSpy)
    }
  }

  t.mock.module('eventsource', {
    defaultExport: TappableES,
    namedExports: { EventSource: TappableES },
  })

  const [{ Client }, { SSEClientTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/client/sse.js'),
  ])

  const transport = new SSEClientTransport(
    new URL('/sse', 'https://b8ad-212-231-122-245.ngrok-free.app'),
  )
  const client = new Client({ name: 'endpoint-tester', version: '0.0.0' })

  await client.connect(transport)
  // give the server a tick
  await new Promise((r) => setTimeout(r, 50))
  await client.close()

  assert.strictEqual(
    endpointSpy.mock.callCount(),
    1,
    'endpoint event should fire exactly once',
  )

  const data = (endpointSpy.mock.calls[0].arguments[0] as MessageEvent).data

  console.log({ data })

  assert.match(
    data,
    /^\/|https?:\/\//,
    'endpoint data must be a relative path or absolute URL',
  )
})
