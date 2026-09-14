import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

// "length" is a valid header name, even though it also names a JavaScript
// property. Verify its actual wire value alongside an ordinary custom header.
for (const mode of ['sse', 'stateful', 'stateless']) {
  test(
    `${mode} preserves a header named length and an ordinary custom header`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const base = `http://127.0.0.1:${port}`
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        mode === 'sse' ? 'sse' : 'streamableHttp',
        '--port',
        String(port),
        '--healthEndpoint',
        '/health',
        '--header',
        'length: custom-value',
        'X-Audit: configured',
        ...(mode === 'stateful' ? ['--stateful'] : []),
        ...(mode === 'sse'
          ? ['--baseUrl', `${base}/forwarded`, '--messagePath', '/messages']
          : []),
      ])
      await gateway.ready()
      const response = await fetch(base + '/health', {
        signal: AbortSignal.timeout(3000),
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('length'), 'custom-value')
      assert.equal(response.headers.get('x-audit'), 'configured')
      assert.equal(await response.text(), 'ok')
      if (mode === 'sse') {
        const stream = await fetch(base + '/sse', {
          signal: AbortSignal.timeout(3000),
        })
        const reader = stream.body!.getReader()
        t.after(() => reader.cancel().catch(() => {}))
        let firstEvent = ''
        while (!firstEvent.includes('\n\n')) {
          const chunk = await reader.read()
          if (chunk.done)
            throw new Error('SSE stream ended before its endpoint event')
          firstEvent += new TextDecoder().decode(chunk.value)
        }
        const data = firstEvent
          .split('\n')
          .find((line) => line.startsWith('data: '))!
        const endpoint = new URL(data.slice(6), stream.url)
        assert.equal(endpoint.pathname, '/forwarded/messages')
        assert.ok(endpoint.searchParams.get('sessionId'))
        await reader.cancel()
      }
    },
  )
}
