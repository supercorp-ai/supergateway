import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'
import { knownBugTest } from './helpers/known-bug.js'

// These clients already work against main through automatic legacy fallback.
// Enabling a new protocol must not silently remove their state or callbacks.
// The auto cases are held until the modern endpoint's compatibility is fixed;
// RUN_KNOWN_BUG_TESTS=1 also runs them against an independently built baseline.
for (const mode of ['auto', 'legacy'] as const) {
  const check =
    mode === 'auto'
      ? knownBugTest.bind(null, 'PR-193 auto-negotiation regression')
      : test

  async function connect(t: TestContext, peer: string) {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      `node tests/helpers/${peer}.mjs`,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const client = new Client(
      { name: 'existing-client', version: '1' },
      {
        versionNegotiation: { mode, probe: { timeoutMs: 3000, maxRetries: 0 } },
        capabilities: { roots: { listChanged: true } },
      },
    )
    const logs: unknown[] = []
    client.setNotificationHandler('notifications/message', (notification) => {
      logs.push(notification.params.data)
    })
    client.setRequestHandler('roots/list', async () => ({
      roots: [{ uri: 'file:///tmp/root-a', name: 'a' }],
    }))
    t.after(() => client.close())
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
      { timeout: 5000 },
    )
    t.diagnostic(`negotiated protocol: ${client.getProtocolEra()}`)
    return { client, logs }
  }

  check(
    `${mode} client preserves state across calls with --stateful`,
    { timeout: 15000 },
    async (t) => {
      const { client } = await connect(t, 'modern-bridge-peer')
      const first = await client.callTool(
        { name: 'identity' },
        { timeout: 5000 },
      )
      const second = await client.callTool(
        { name: 'identity' },
        { timeout: 5000 },
      )
      assert.equal(first.content[0].type, 'text')
      assert.equal(second.content[0].type, 'text')
      const a = JSON.parse(first.content[0].text as string)
      const b = JSON.parse(second.content[0].text as string)
      assert.deepEqual(
        { first: a.count, second: b.count },
        { first: 1, second: 2 },
      )
      assert.equal(
        b.pid,
        a.pid,
        'the same initialized backend serves both calls',
      )
    },
  )

  check(
    `${mode} client receives log notifications during a tool call`,
    { timeout: 15000 },
    async (t) => {
      const { client, logs } = await connect(t, 'reverse-peer')
      const result = await client.callTool(
        { name: 'log', arguments: {} },
        { timeout: 5000 },
      )
      assert.deepEqual(result.content, [{ type: 'text', text: 'logged' }])
      await delay(500)
      assert.deepEqual(logs, ['log-info', 'log-warning', 'log-error'])
    },
  )

  check(
    `${mode} client answers a backend roots request`,
    { timeout: 15000 },
    async (t) => {
      const { client } = await connect(t, 'reverse-peer')
      const result = await client.callTool(
        { name: 'roots', arguments: {} },
        { timeout: 5000 },
      )
      assert.deepEqual(result.content, [
        { type: 'text', text: 'roots:file:///tmp/root-a' },
      ])
    },
  )
}
