import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import express from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  stdioRpc,
} from './helpers/gateway-process.js'

const source = {
  url: 'https://nodejs.org/api/test.html?view=public&lang=en#test-runner',
  title: 'Test runner',
  excerpts: ['Public documentation — node:test'],
}
const results: Record<string, CallToolResult> = {
  documentation: {
    content: [{ type: 'text', text: JSON.stringify({ results: [source] }) }],
    structuredContent: { results: [source] },
    _meta: { sourceUrl: source.url },
  },
  empty: {
    content: [{ type: 'text', text: '{"results":[]}' }],
    structuredContent: { results: [] },
  },
  unavailable: {
    isError: true,
    content: [{ type: 'text', text: 'Search temporarily unavailable' }],
  },
}

// A local SDK server: no API key, account state or external retrieval in CI.
async function searchServer(t: TestContext) {
  const calls: unknown[] = []
  const server = new Server(
    { name: 'public-search-fixture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: ['web_search', 'web_fetch'].map((name) => ({
      name,
      inputSchema: { type: 'object' as const },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    calls.push(params)
    assert.equal(params.name, 'web_search', 'no other tool reaches upstream')
    return results[String(params.arguments?.objective)]
  })
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  })
  await server.connect(transport)
  const app = express()
  app.use(express.json())
  app.all('/mcp', async (req, res) => {
    await transport.handleRequest(req, res, req.body)
  })
  const http = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
  })
  t.after(async () => {
    await server.close()
    http.closeAllConnections()
    await new Promise<void>((resolve) => http.close(() => resolve()))
  })
  const port = (http.address() as { port: number }).port
  return { url: `http://127.0.0.1:${port}/mcp`, calls }
}

for (const filtered of [false, true]) {
  test(
    `public search results cross HTTP to stdio unchanged (${filtered ? 'search allowlist' : 'default tools'})`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const upstream = await searchServer(t)
      const bridge = launchGateway(t, [
        '--streamableHttp',
        upstream.url,
        ...(filtered ? ['--tools', 'web_search'] : []),
      ])
      await bridge.ready()
      await stdioRpc(bridge, initialize(1))
      const listing = await stdioRpc(bridge, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      })
      assert.deepEqual(
        listing.result.tools.map((tool: { name: string }) => tool.name),
        filtered ? ['web_search'] : ['web_search', 'web_fetch'],
      )
      let id = 3
      for (const [objective, expected] of Object.entries(results)) {
        const params = {
          name: 'web_search',
          arguments: { objective, search_queries: ['node:test documentation'] },
        }
        const reply = await stdioRpc(bridge, {
          jsonrpc: '2.0',
          id: id++,
          method: 'tools/call',
          params,
        })
        assert.equal(reply.error, undefined)
        assert.deepEqual(reply.result, expected, objective)
        assert.deepEqual(upstream.calls.at(-1), params)
      }
      if (filtered) {
        const refused = await stdioRpc(bridge, {
          jsonrpc: '2.0',
          id: id++,
          method: 'tools/call',
          params: { name: 'web_fetch', arguments: {} },
        })
        assert.equal(refused.error.code, -32602)
      }
      assert.equal(upstream.calls.length, 3)
      assert.equal(bridge.child.exitCode, null)
    },
  )
}
