import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomInt } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { stdioToSse } from '../src/gateways/stdioToSse.js'
import { getLogger } from '../src/lib/getLogger.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'

const BASE_URL = 'http://localhost:11001'
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

test.before(async () => {
  await stdioToSse({
    stdioCmd: 'npx -y @modelcontextprotocol/server-everything',
    port: 11001,
    baseUrl: BASE_URL,
    ssePath: SSE_PATH,
    messagePath: '/message',
    logger: getLogger({ logLevel: 'info', outputTransport: 'stdio' }),
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
  })
})

test.after(async () => {
  await new Promise<void>((res) => setTimeout(res, 30000))
  process.kill(process.pid, 'SIGINT')
})

test('concurrent listTools → callTool', async () => {
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

    const transport = new SSEClientTransport(new URL(SSE_PATH, BASE_URL), {
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

    await client.connect(transport)

    const tools = await span('listTools', () => client.listTools())
    assert.ok(Array.isArray(tools.tools), 'listTools() must return array')

    const rnd = randomInt(1, 51)
    const reply = await span('add', () =>
      client.callTool({ name: 'add', arguments: { a: id, b: rnd } }, undefined),
    )
    const content = reply.content as any
    const text = content && content[0]?.text
    console.log({ text })
    assert.strictEqual(text, `The sum of ${id} and ${rnd} is ${id + rnd}.`)

    await client.close()
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
