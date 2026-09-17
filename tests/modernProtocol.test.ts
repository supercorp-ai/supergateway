import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import {
  launchGateway,
  unusedPort,
  peerCommand,
} from './helpers/gateway-process.js'

const VERSION = '2026-07-28'
const options = { timeout: 20000 }
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
  mode: 'auto' | 'legacy' | { pin: typeof VERSION },
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

async function gateway(t: TestContext, args: string[], command = peerCommand) {
  const port = await unusedPort()
  const child = launchGateway(t, [
    '--stdio',
    command,
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
      const result = await client.callTool(
        { name: 'probe' },
        {
          timeout: 5000,
        },
      )
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
    `${mode.label}: explicit legacy SDK client still completes a legacy tool call`,
    options,
    async (t) => {
      const url = await gateway(t, mode.args)
      const { client, transport, exchanges } = await clientFor(t, url, 'legacy')
      await client.connect(transport, { timeout: 5000 })
      assert.equal(client.getProtocolEra(), 'legacy')
      const tools = await client.listTools({}, { timeout: 5000 })
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ['add'],
      )
      const result = await client.callTool(
        { name: 'add', arguments: { a: 2, b: 3 } },
        { timeout: 5000 },
      )
      assert.deepEqual(result.content, [
        { type: 'text', text: 'The sum of 2 and 3 is 5.' },
      ])
      assert.equal(exchanges[0].body?.method, 'initialize')
      assert.equal(exchanges[0].status, 200)
      assert.ok(
        exchanges.some(
          (exchange) =>
            exchange.body?.method === 'initialize' && exchange.status === 200,
        ),
      )
    },
  )

  // Transport conversion must not manufacture protocol support the backend lacks.
  test(
    `${mode.label}: a modern-only client cannot negotiate with a legacy-only child`,
    options,
    async (t) => {
      const url = await gateway(t, mode.args)
      const { client, transport, exchanges } = await clientFor(t, url, {
        pin: VERSION,
      })
      await assert.rejects(
        client.connect(transport, { timeout: 5000 }),
        /protocol|method|modern|support/i,
      )
      assert.deepEqual(
        exchanges.map((exchange) => exchange.body?.method),
        ['server/discover'],
      )
      assert.equal(client.getDiscoverResult(), undefined)
    },
  )
}

for (const mode of modes) {
  test(
    `${mode.label}: modern client calls an official SDK v2 stdio server`,
    options,
    async (t) => {
      const url = await gateway(
        t,
        mode.args,
        'node tests/helpers/modern-sdk-peer.mjs',
      )
      const { client, transport } = await clientFor(t, url, { pin: VERSION })
      await client.connect(transport, { timeout: 5000 })
      assert.equal(client.getProtocolEra(), 'modern')
      assert.deepEqual(
        (await client.listTools({}, { timeout: 5000 })).tools.map(
          (tool) => tool.name,
        ),
        ['probe'],
      )
      const result = await client.callTool({ name: 'probe' }, { timeout: 5000 })
      assert.deepEqual(result.content, [
        { type: 'text', text: 'official SDK stdio result' },
      ])
    },
  )
}
