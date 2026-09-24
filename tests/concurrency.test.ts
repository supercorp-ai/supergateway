import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

const SSE_PATH = '/sse'
const CONCURRENCY = 1

function makeLimiter(maxConcurrency: number) {
  let active = 0
  const queue: (() => void)[] = []

  return async function <T>(fn: () => Promise<T>): Promise<T> {
    if (active >= maxConcurrency) {
      // wait for a slot
      await new Promise<void>((res) => queue.push(res))
    }
    active++
    try {
      return await fn()
    } finally {
      active--
      // free up next waiter
      const next = queue.shift()
      if (next) next()
    }
  }
}

const limit = makeLimiter(CONCURRENCY)

test('concurrent listTools → callTool', { timeout: 30000 }, async (t) => {
  // An unused port and the harness's readiness wait replace a fixed port and a
  // two-second sleep. On a loaded macOS runner `npm run start` alone outlasted
  // that sleep, the client connected to nothing, and — because the failed
  // transport was never closed — EventSource kept reconnecting until the CI
  // job's twelve-minute timeout, with no test summary to say why. The harness
  // also honours SUPERGATEWAY_TEST_ENTRY, so a soak exercises the published
  // artifact here rather than the local build.
  const port = await unusedPort()
  const baseUrl = `http://127.0.0.1:${port}`
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--outputTransport',
    'sse',
    '--port',
    String(port),
    '--baseUrl',
    baseUrl,
    '--ssePath',
    SSE_PATH,
    '--messagePath',
    '/message',
  ])
  await gateway.ready()

  const succeededInstances: { id: number; text: string }[] = []

  const runClient = async (id: number) => {
    const headers = {
      Authorization: 'Bearer YOUR_API_KEY',
      'X-Instance-ID': String(id),
    }

    /** helper wrapper so TS sees correct `(input, init?)` signature */
    const fetchWithHeaders =
      (hdrs: Record<string, string>) =>
      (input: RequestInfo | URL, init: RequestInit = {}) =>
        fetch(input, { ...init, headers: { ...init.headers, ...hdrs } })

    const transport = new SSEClientTransport(new URL(SSE_PATH, baseUrl), {
      eventSourceInit: { fetch: fetchWithHeaders(headers) },
      requestInit: { headers },
    })

    const client = new Client({ name: `load-${id}`, version: '0.0.0' })

    const timing: Record<string, number> = {}
    const span = async <T>(label: string, fn: () => Promise<T>) => {
      const t0 = performance.now()
      const out = await fn()
      timing[label] = performance.now() - t0
      return out
    }

    // Closing on every path is what stops a failed connection reconnecting
    // forever and holding the test process open.
    let text: string
    try {
      await client.connect(transport)

      const tools = await span('listTools', () => client.listTools())
      assert.ok(Array.isArray(tools.tools), 'listTools() must return array')

      const rnd = randomInt(1, 51)
      const reply = await span('add', () =>
        client.callTool(
          { name: 'add', arguments: { a: id, b: rnd } },
          undefined,
        ),
      )
      const content = reply.content as any
      text = content && content[0]?.text
      console.log({ text })
      assert.strictEqual(text, `The sum of ${id} and ${rnd} is ${id + rnd}.`)
    } finally {
      await client.close()
      await transport.close()
    }
    console.log(`Instance ${id} timings:`, timing)
    succeededInstances.push({
      id,
      text,
    })
  }

  await Promise.all(
    Array.from({ length: CONCURRENCY }, (_, i) =>
      limit(() => runClient(i + 1)),
    ),
  )

  assert.strictEqual(
    succeededInstances.length,
    CONCURRENCY,
    'All instances should succeed',
  )

  console.log({ succeededInstances })
})
