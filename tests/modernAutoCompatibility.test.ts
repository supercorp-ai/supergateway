import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import {
  launchGateway,
  unusedPort,
  gatewayTimeout,
  requestTimeout,
} from './helpers/gateway-process.js'

// These clients already work against main through automatic legacy fallback.
// State and roots assertions hold the existing gateway compatibility contract,
// not protocol conformance: modern MCP removes transport-level sessions and
// replaces reverse requests with input_required results. Logging has a separate
// per-request opt-in rule, so unsolicited modern logs must not be expected.
// Run the same cases against independently built main and release baselines.
for (const mode of ['auto', 'legacy'] as const) {
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
        versionNegotiation: {
          mode,
          probe: { timeoutMs: requestTimeout(3000), maxRetries: 0 },
        },
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
      { timeout: requestTimeout(5000) },
    )
    t.diagnostic(`negotiated protocol: ${client.getProtocolEra()}`)
    return { client, logs }
  }

  test(
    `${mode} client preserves state across calls with --stateful`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const { client } = await connect(t, 'modern-bridge-peer')
      const first = await client.callTool(
        { name: 'identity' },
        { timeout: requestTimeout(5000) },
      )
      const second = await client.callTool(
        { name: 'identity' },
        { timeout: requestTimeout(5000) },
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

  test(
    `${mode} client follows negotiated logging rules without a requested log level`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const { client, logs } = await connect(t, 'reverse-peer')
      const result = await client.callTool(
        { name: 'log', arguments: {} },
        { timeout: requestTimeout(5000) },
      )
      assert.deepEqual(result.content, [{ type: 'text', text: 'logged' }])
      await delay(500)
      assert.deepEqual(
        logs,
        client.getProtocolEra() === 'modern'
          ? []
          : ['log-info', 'log-warning', 'log-error'],
      )
    },
  )

  test(
    `${mode} client answers a backend roots request`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const { client } = await connect(t, 'reverse-peer')
      const result = await client.callTool(
        { name: 'roots', arguments: {} },
        { timeout: requestTimeout(5000) },
      )
      assert.deepEqual(result.content, [
        { type: 'text', text: 'roots:file:///tmp/root-a' },
      ])
    },
  )
}
