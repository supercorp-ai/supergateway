import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import {
  CreateMessageRequestSchema,
  ElicitRequestSchema,
  ListRootsRequestSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * The two bridges in the server→client direction: stdio client ⇄ bridge ⇄
 * gateway ⇄ peer. Both bridges talk upstream through the SDK's `Client`, which
 * used to receive everything and handle none of it: log, progress, list-changed
 * and resource-update notifications were dropped, and the server's own
 * requests (sampling, roots, elicitation) were answered "Method not found"
 * before the stdio client ever saw them.
 */
const BRIDGES = [
  { flag: '--sse', path: '/sse', upstream: ['--outputTransport', 'sse'] },
  {
    flag: '--streamableHttp',
    path: '/mcp',
    upstream: ['--outputTransport', 'streamableHttp', '--stateful'],
  },
] as const

// Bounded: a relay that drops a request must fail the test, not hang it.
const CALL = { timeout: requestTimeout(10000) }

async function bridge(
  t: TestContext,
  kind: (typeof BRIDGES)[number],
  peer: string,
) {
  const port = await unusedPort()
  const upstream = launchGateway(
    t,
    ['--stdio', peer, '--port', String(port), ...kind.upstream],
    { PROGRESS_SPACING: '1' },
  )
  await upstream.ready()
  const client = new Client(
    { name: 'bridge-reverse', version: '1.0.0' },
    { capabilities: { sampling: {}, roots: {}, elicitation: {} } },
  )
  t.after(() => client.close().catch(() => {}))
  return {
    client,
    upstream,
    connect: () =>
      client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js',
            kind.flag,
            `http://127.0.0.1:${port}${kind.path}`,
            '--logLevel',
            'none',
          ],
        }),
        CALL,
      ),
  }
}

const textOf = (reply: unknown) =>
  (reply as { content: Array<{ text: string }> }).content[0].text

for (const kind of BRIDGES) {
  test(
    `${kind.flag} bridge relays the server's notifications and requests`,
    { timeout: gatewayTimeout(60000) },
    async (t) => {
      const { client, upstream, connect } = await bridge(
        t,
        kind,
        'node tests/helpers/reverse-peer.mjs',
      )
      const logs: unknown[] = []
      client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
        logs.push(n.params.data)
      })
      client.setRequestHandler(CreateMessageRequestSchema, async () => ({
        model: 'offline-stub',
        role: 'assistant',
        content: { type: 'text', text: 'pong' },
      }))
      client.setRequestHandler(ListRootsRequestSchema, async () => ({
        roots: [{ uri: 'file:///tmp/root-a' }],
      }))
      client.setRequestHandler(ElicitRequestSchema, async () => ({
        action: 'accept' as const,
        content: { name: 'domas' },
      }))
      await connect()

      await client.callTool({ name: 'log', arguments: {} }, undefined, CALL)
      await upstream.waitFor(() => logs.length >= 3, 'relay three log messages')
      assert.deepEqual(logs, ['log-info', 'log-warning', 'log-error'])

      // Counted by a handler of the client's own: the SDK's `onprogress` drops
      // a notification read together with the result (GW-027, upstream), which
      // a loaded soak runner makes likely. `onprogress` still sends the token.
      const progress: number[] = []
      client.setNotificationHandler(ProgressNotificationSchema, (n) => {
        progress.push(n.params.progress)
      })
      await client.callTool({ name: 'progress', arguments: {} }, undefined, {
        ...CALL,
        onprogress: () => {},
      })
      await upstream.waitFor(() => progress.length >= 3, 'relay progress')
      assert.deepEqual(progress, [1, 2, 3])

      for (const [tool, expected] of [
        ['sample', 'sampled:pong'],
        ['roots', 'roots:file:///tmp/root-a'],
        ['elicit', 'elicited:accept:domas'],
      ] as const) {
        const reply = await client.callTool(
          { name: tool, arguments: {} },
          undefined,
          CALL,
        )
        assert.equal(textOf(reply), expected, `${tool} did not complete`)
      }
    },
  )

  test(
    `${kind.flag} bridge relays resource updates and list changes`,
    { timeout: gatewayTimeout(60000) },
    async (t) => {
      const { client, upstream, connect } = await bridge(
        t,
        kind,
        'node tests/helpers/surface-peer.mjs',
      )
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
      await connect()
      await client.subscribeResource({ uri: 'note://alpha' }, CALL)
      await client.callTool({ name: 'touch', arguments: {} }, undefined, CALL)
      await upstream.waitFor(
        () => seen.length >= 3,
        'relay three notifications',
      )
      assert.deepEqual(seen.sort(), [
        'prompts-changed',
        'resources-changed',
        'updated:note://alpha',
      ])
    },
  )
}
