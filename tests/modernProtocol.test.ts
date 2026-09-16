import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { knownBugTest } from './helpers/known-bug.js'
import {
  launchGateway,
  unusedPort,
  peerCommand,
} from './helpers/gateway-process.js'

const VERSION = '2026-07-28'
// The v2 test clients require Node 20. Keep the gateway's Node 18 tests running
// without importing those packages or changing its production dependencies.
const modernRuntime = Number(process.versions.node.split('.')[0]) >= 20
const options = {
  timeout: 20000,
  skip: modernRuntime ? false : 'SDK v2 requires Node 20',
}
const modes = [
  { label: 'stateful', args: ['--stateful'] },
  { label: 'stateless', args: [] },
]

type Exchange = {
  method: string
  headers: Headers
  body?: { method: string; params?: { _meta?: Record<string, unknown> } }
  status?: number
}

async function clientFor(
  t: TestContext,
  url: string,
  mode: 'auto' | { pin: typeof VERSION },
) {
  const { Client, StreamableHTTPClientTransport } = await import(
    '@modelcontextprotocol/client'
  )
  const exchanges: Exchange[] = []
  const client = new Client(
    { name: 'protocol-regression', version: '1.0.0' },
    { versionNegotiation: { mode, probe: { timeoutMs: 5000, maxRetries: 0 } } },
  )
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: async (input, init) => {
      const request = new Request(input, init)
      const body = await request.clone().text()
      const exchange: Exchange = {
        method: request.method,
        headers: request.headers,
        ...(body ? { body: JSON.parse(body) } : {}),
      }
      exchanges.push(exchange)
      const response = await fetch(request)
      exchange.status = response.status
      return response
    },
  })
  t.after(() => client.close())
  return { client, transport, exchanges }
}

async function gateway(t: TestContext, args: string[]) {
  const port = await unusedPort()
  const child = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--outputTransport',
    'streamableHttp',
    '--port',
    String(port),
    ...args,
  ])
  await child.ready()
  return `http://127.0.0.1:${port}/mcp`
}

async function modernServer(t: TestContext) {
  const { McpServer, createMcpHandler } = await import(
    '@modelcontextprotocol/server'
  )
  const { toNodeHandler } = await import('@modelcontextprotocol/node')
  const handler = createMcpHandler(
    () => {
      const server = new McpServer({ name: 'modern-control', version: '1.0.0' })
      server.registerTool('probe', {}, async () => ({
        content: [{ type: 'text', text: 'modern control result' }],
      }))
      return server
    },
    { legacy: 'reject' },
  )
  const server = createServer(toNodeHandler(handler))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}/mcp`
}

for (const mode of ['auto', { pin: VERSION }] as const) {
  test(
    `modern SDK control: ${typeof mode === 'string' ? mode : 'pinned'} client discovers and calls a tool`,
    options,
    async (t) => {
      const url = await modernServer(t)
      const { client, transport, exchanges } = await clientFor(t, url, mode)
      await client.connect(transport, { timeout: 5000 })
      assert.equal(client.getProtocolEra(), 'modern')
      const tools = await client.listTools({}, { timeout: 5000 })
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ['probe'],
      )
      const result = await client.callTool({ name: 'probe' }, undefined, {
        timeout: 5000,
      })
      assert.deepEqual(result.content, [
        { type: 'text', text: 'modern control result' },
      ])
      assert.deepEqual(
        exchanges.map((exchange) => exchange.body?.method),
        ['server/discover', 'tools/list', 'tools/call'],
      )
      for (const exchange of exchanges) {
        assert.equal(exchange.status, 200)
        assert.equal(exchange.headers.get('mcp-protocol-version'), VERSION)
        assert.equal(exchange.headers.get('mcp-method'), exchange.body?.method)
        assert.equal(exchange.headers.has('mcp-session-id'), false)
        assert.equal(
          exchange.body?.params?._meta?.[
            'io.modelcontextprotocol/protocolVersion'
          ],
          VERSION,
        )
      }
      assert.equal(exchanges.at(-1)?.headers.get('mcp-name'), 'probe')
    },
  )
}

for (const mode of modes) {
  test(
    `${mode.label}: modern SDK auto client falls back and completes a legacy tool call`,
    options,
    async (t) => {
      const url = await gateway(t, mode.args)
      const { client, transport, exchanges } = await clientFor(t, url, 'auto')
      await client.connect(transport, { timeout: 5000 })
      assert.equal(client.getProtocolEra(), 'legacy')
      const tools = await client.listTools({}, { timeout: 5000 })
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ['add'],
      )
      const result = await client.callTool(
        { name: 'add', arguments: { a: 2, b: 3 } },
        undefined,
        { timeout: 5000 },
      )
      assert.deepEqual(result.content, [
        { type: 'text', text: 'The sum of 2 and 3 is 5.' },
      ])
      assert.equal(exchanges[0].body?.method, 'server/discover')
      assert.equal(exchanges[0].headers.get('mcp-protocol-version'), VERSION)
      assert.equal(exchanges[0].status, 400)
      assert.ok(
        exchanges.some(
          (exchange) =>
            exchange.body?.method === 'initialize' && exchange.status === 200,
        ),
      )
    },
  )

  // This is the actual compatibility target. The same real client passes the
  // modern-server controls above. An unsupported header alone is not proof
  // of a gateway defect, and accepting that header would not pass this test.
  knownBugTest(
    '#156',
    `${mode.label}: a modern-only client discovers and calls a legacy child tool`,
    { timeout: 20000 },
    async (t) => {
      if (!modernRuntime) return t.skip('SDK v2 requires Node 20')
      const url = await gateway(t, mode.args)
      const { client, transport, exchanges } = await clientFor(t, url, {
        pin: VERSION,
      })
      try {
        await client.connect(transport, { timeout: 5000 })
      } catch (error) {
        const probe = exchanges[0]
        assert.equal(probe.body?.method, 'server/discover')
        assert.equal(
          probe.status,
          400,
          'reproduction must fail with a response, not a timeout',
        )
        assert.equal(
          (error as { code?: string }).code,
          'ERA_NEGOTIATION_FAILED',
        )
        throw error
      }
      assert.equal(client.getProtocolEra(), 'modern')
      assert.ok(
        (await client.listTools({}, { timeout: 5000 })).tools.some(
          (tool) => tool.name === 'add',
        ),
      )
      const result = await client.callTool(
        { name: 'add', arguments: { a: 2, b: 3 } },
        undefined,
        { timeout: 5000 },
      )
      assert.deepEqual(result.content, [
        { type: 'text', text: 'The sum of 2 and 3 is 5.' },
      ])
      assert.equal(
        exchanges.some((exchange) => exchange.body?.method === 'initialize'),
        false,
      )
    },
  )
}
