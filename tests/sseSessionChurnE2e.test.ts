import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

test(
  'SSE session churn does not disconnect a healthy client or resurrect closed endpoints',
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
    const base = `http://127.0.0.1:${port}`
    const client = new Client(
      { name: 'stable-client', version: '1.0.0' },
      { capabilities: {} },
    )
    const transport = new SSEClientTransport(new URL(base + '/sse'))
    t.after(() => client.close())
    t.after(() => transport.close())
    await client.connect(transport)
    const endpoints = new Set<string>()
    for (let cycle = 0; cycle < 6; cycle++) {
      const newcomers = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const abort = new AbortController()
          t.after(() => abort.abort())
          const response = await fetch(base + '/sse', { signal: abort.signal })
          assert.equal(response.status, 200)
          const reader = response.body!.getReader()
          const decoder = new TextDecoder()
          let frame = ''
          while (!frame.includes('\n\n')) {
            const chunk = await reader.read()
            assert.equal(chunk.done, false)
            frame += decoder.decode(chunk.value, { stream: true })
          }
          const endpoint = frame
            .split('\n')
            .find((line) => line.startsWith('data:'))!
            .slice(5)
            .trim()
          assert.ok(endpoint.startsWith('/message?sessionId='))
          assert.equal(endpoints.has(endpoint), false)
          endpoints.add(endpoint)
          return { abort, endpoint }
        }),
      )
      const serving = client.callTool({
        name: 'add',
        arguments: { a: cycle, b: 17 },
      })
      for (const newcomer of newcomers.reverse()) newcomer.abort.abort()
      assert.deepEqual(await serving, {
        content: [
          {
            type: 'text',
            text: `The sum of ${cycle} and 17 is ${cycle + 17}.`,
          },
        ],
      })
      await gateway.waitFor(
        () =>
          (gateway.output().match(/SSE connection closed \(session /g) ?? [])
            .length >=
          (cycle + 1) * 4,
        'observe every churned session closing',
      )
      for (const newcomer of newcomers) {
        const stale = await fetch(base + newcomer.endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 999,
            method: 'tools/list',
          }),
          signal: AbortSignal.timeout(3000),
        })
        assert.equal(stale.status, 503)
        await stale.text()
      }
    }
    assert.equal(endpoints.size, 24)
    assert.equal(gateway.child.exitCode, null)
    assert.equal(gateway.child.signalCode, null)
    assert.doesNotMatch(
      gateway.errors(),
      /Maximum call stack|Already connected|UnhandledPromiseRejection/,
    )
  },
)
