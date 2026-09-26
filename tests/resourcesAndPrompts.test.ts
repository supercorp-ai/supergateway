import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import {
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20,
// which the compat job still covers, and the SDK's transport needs one.
import { WebSocket } from 'ws'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * Every other test exercises tools. MCP servers also expose resources and
 * prompts, and a resource subscription is server-initiated push: the server
 * says `notifications/resources/updated` when the client never asked in that
 * exchange. `surface-peer.mjs` serves one resource, one prompt and a tool that
 * announces changes to both.
 *
 * Stateless HTTP starts a fresh child per request, so a subscription cannot
 * outlive the request that made it. There the test checks reads and gets only.
 */
const MODES = [
  {
    label: 'stateful HTTP',
    args: ['--outputTransport', 'streamableHttp', '--stateful'],
    path: '/mcp',
    kind: 'http',
    session: true,
  },
  {
    label: 'stateless HTTP',
    args: ['--outputTransport', 'streamableHttp'],
    path: '/mcp',
    kind: 'http',
    session: false,
  },
  {
    label: 'SSE',
    args: ['--outputTransport', 'sse'],
    path: '/sse',
    kind: 'sse',
    session: true,
  },
  {
    label: 'WebSocket',
    args: ['--outputTransport', 'ws'],
    path: '/message',
    kind: 'ws',
    session: true,
  },
] as const

async function connect(t: TestContext, mode: (typeof MODES)[number]) {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    'node tests/helpers/surface-peer.mjs',
    '--port',
    String(port),
    ...mode.args,
  ])
  await gateway.ready()
  const url = new URL(`http://127.0.0.1:${port}${mode.path}`)
  const client = new Client({ name: 'surface', version: '1.0.0' })
  t.after(() => client.close().catch(() => {}))
  if (mode.kind === 'ws') {
    globalThis.WebSocket ??= WebSocket as unknown as typeof globalThis.WebSocket
    url.protocol = 'ws:'
  }
  await client.connect(
    mode.kind === 'ws'
      ? new WebSocketClientTransport(url)
      : mode.kind === 'sse'
        ? new SSEClientTransport(url)
        : new StreamableHTTPClientTransport(url),
  )
  return { client, gateway }
}

for (const mode of MODES) {
  test(
    `${mode.label}: resources and prompts cross the gateway`,
    { timeout: 60000 },
    async (t) => {
      const { client, gateway } = await connect(t, mode)

      const { resources } = await client.listResources()
      assert.deepEqual(
        resources.map((r) => r.uri),
        ['note://alpha'],
      )
      const read = await client.readResource({ uri: 'note://alpha' })
      assert.deepEqual(read.contents, [
        { uri: 'note://alpha', mimeType: 'text/plain', text: 'alpha-body' },
      ])

      const { prompts } = await client.listPrompts()
      assert.deepEqual(
        prompts.map((p) => p.name),
        ['greet'],
      )
      const prompt = await client.getPrompt({
        name: 'greet',
        arguments: { who: 'domas' },
      })
      assert.deepEqual(prompt.messages, [
        { role: 'user', content: { type: 'text', text: 'hello domas' } },
      ])

      if (!mode.session) return

      const seen: string[] = []
      client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => {
        seen.push(`updated:${n.params.uri}`)
      })
      client.setNotificationHandler(
        ResourceListChangedNotificationSchema,
        () => {
          seen.push('resources-changed')
        },
      )
      client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
        seen.push('prompts-changed')
      })
      await client.subscribeResource({ uri: 'note://alpha' })
      await client.callTool({ name: 'touch', arguments: {} })
      await gateway.waitFor(
        () => seen.length >= 3,
        'deliver the update and both list-changed notifications',
      )
      assert.deepEqual(seen.sort(), [
        'prompts-changed',
        'resources-changed',
        'updated:note://alpha',
      ])
    },
  )
}
