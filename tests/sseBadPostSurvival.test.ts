import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

// #190: the SDK reports errors on individual POSTs through `onerror`. Those
// requests must fail without closing the SSE connection they were sent to.
for (const bad of [
  {
    name: 'oversized JSON',
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'x', arguments: { blob: 'A'.repeat(5 * 1024 * 1024) } },
    }),
    headers: { 'content-type': 'application/json' },
  },
  {
    name: 'wrong content type',
    body: '{}',
    headers: { 'content-type': 'text/plain' },
  },
  { name: 'missing content type', body: Buffer.from('{}'), headers: {} },
  {
    name: 'invalid JSON-RPC shape',
    body: '{"hello":"world"}',
    headers: { 'content-type': 'application/json' },
  },
  {
    name: 'invalid JSON syntax',
    body: '{not json',
    headers: { 'content-type': 'application/json' },
  },
] as const) {
  test(
    `SSE session survives ${bad.name} POST`,
    { timeout: 30000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--port',
        String(port),
      ])
      await gateway.ready()

      const abort = new AbortController()
      t.after(() => abort.abort())
      const opened = await fetch(`http://127.0.0.1:${port}/sse`, {
        headers: { accept: 'text/event-stream' },
        signal: abort.signal,
      })
      assert.equal(opened.status, 200)
      const frames: string[] = []
      const reader = opened.body!.getReader()
      const decoder = new TextDecoder()
      void (async () => {
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done) return
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines)
            if (line.startsWith('data:')) frames.push(line.slice(5).trim())
        }
      })().catch(() => {})
      await gateway.waitFor(
        () => frames.some((frame) => frame.startsWith('/message')),
        'announce an SSE message endpoint',
      )
      const endpoint = frames.find((frame) => frame.startsWith('/message'))!
      const post = (body: string | Buffer, headers: Record<string, string>) =>
        fetch(`http://127.0.0.1:${port}${endpoint}`, {
          method: 'POST',
          headers,
          body,
          signal: AbortSignal.timeout(10000),
        })

      const first = await post(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
        { 'content-type': 'application/json' },
      )
      assert.equal(first.status, 202)
      await first.text()

      const rejected = await post(
        bad.body,
        bad.headers as Record<string, string>,
      )
      assert.equal(rejected.status, 400)
      await rejected.text()

      const next = await post(
        JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' }),
        { 'content-type': 'application/json' },
      )
      assert.equal(next.status, 202, 'one bad POST must not remove the session')
      await next.text()
      await gateway.waitFor(
        () => frames.some((frame) => frame.includes('"id":3')),
        'deliver the next response on the original SSE stream',
      )
      assert.equal(gateway.child.exitCode, null)
    },
  )
}
