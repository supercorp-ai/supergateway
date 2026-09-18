import { setTimeout as delay } from 'node:timers/promises'
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import {
  launchGateway,
  unusedPort,
  gatewayTimeout,
  requestTimeout,
} from './helpers/gateway-process.js'

async function client(
  t: TestContext,
  wrapped: boolean,
  stateful: boolean,
  modernOnly: boolean,
) {
  const peer = 'tests/helpers/transparent-sdk-peer.mjs'
  const args = modernOnly ? ['--modern-only'] : []
  const result = new Client(
    { name: 'original-client', version: '7' },
    {
      capabilities: { roots: {} },
      versionNegotiation: {
        mode: { pin: '2026-07-28' },
        probe: { timeoutMs: requestTimeout(3000), maxRetries: 0 },
      },
    },
  )
  result.setRequestHandler('roots/list', async () => ({
    roots: [{ uri: 'file:///workspace', name: 'workspace' }],
  }))
  t.after(() => result.close())
  if (wrapped) {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      `node ${peer} ${args.join(' ')}`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      ...(stateful ? ['--stateful'] : []),
    ])
    await gateway.ready()
    await result.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
      { timeout: requestTimeout(5000) },
    )
  } else {
    await result.connect(
      new StdioClientTransport({ command: 'node', args: [peer, ...args] }),
      { timeout: requestTimeout(5000) },
    )
  }
  return result
}

for (const modernOnly of [false, true]) {
  test(
    `direct official SDK control: ${modernOnly ? 'modern-only' : 'dual'} backend completes roots round trip`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const direct = await client(t, false, false, modernOnly)
      const reply = await direct.callTool({ name: 'roots', arguments: {} })
      assert.deepEqual(reply.content, [
        {
          type: 'text',
          text: JSON.stringify({
            roots: { roots: [{ uri: 'file:///workspace', name: 'workspace' }] },
            state: 'opaque-state:α/+=',
          }),
        },
      ])
    },
  )
}

for (const modernOnly of [false, true])
  for (const stateful of [false, true]) {
    test(
      `modern transport preserves direct behavior: backend=${modernOnly ? 'modern-only' : 'dual'} gateway=${stateful ? 'stateful' : 'stateless'}`,
      { timeout: gatewayTimeout(20000) },
      async (t) => {
        const direct = await client(t, false, stateful, modernOnly)
        const through = await client(t, true, stateful, modernOnly)
        assert.equal(through.getProtocolEra(), direct.getProtocolEra())
        assert.deepEqual(
          through.getDiscoverResult(),
          direct.getDiscoverResult(),
        )
        assert.deepEqual(await through.listTools(), await direct.listTools())
        const request = {
          name: 'inspect',
          arguments: { value: 'héllo' },
          _meta: { custom: 'preserved' },
        }
        assert.deepEqual(
          await through.callTool(request),
          await direct.callTool(request),
        )
        const interactive = { name: 'roots', arguments: {} }
        const expected = await direct.callTool(interactive)
        assert.deepEqual(expected.content, [
          {
            type: 'text',
            text: JSON.stringify({
              roots: {
                roots: [{ uri: 'file:///workspace', name: 'workspace' }],
              },
              state: 'opaque-state:α/+=',
            }),
          },
        ])
        assert.deepEqual(await through.callTool(interactive), expected)
        assert.deepEqual(
          await through.readResource({ uri: 'note://one' }),
          await direct.readResource({ uri: 'note://one' }),
        )
      },
    )
  }

for (const wrapped of [false, true]) {
  test(
    `${wrapped ? 'wrapped' : 'direct'} official SDK: opt-in logs and subscription notifications survive`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const peer = await client(t, wrapped, true, true)
      const logs: unknown[] = []
      peer.setNotificationHandler('notifications/message', (message) =>
        logs.push(message.params.data),
      )
      const logged = await peer.callTool(
        {
          name: 'logs',
          arguments: {},
          _meta: { 'io.modelcontextprotocol/logLevel': 'info' },
        },
        { timeout: requestTimeout(3000) },
      )
      assert.deepEqual(logged.content, [{ type: 'text', text: 'logged' }])
      assert.deepEqual(logs, ['visible log'])
      const changes: unknown[] = []
      peer.setNotificationHandler(
        'notifications/tools/list_changed',
        (message) => changes.push(message),
      )
      const subscription = await peer.listen(
        { toolsListChanged: true },
        { timeout: requestTimeout(3000) },
      )
      t.after(() => subscription.close())
      assert.deepEqual(subscription.honoredFilter, { toolsListChanged: true })
      for (
        const end = Date.now() + 3000;
        changes.length === 0 && Date.now() < end;

      )
        await delay(10)
      assert.ok(
        changes.length > 0,
        'the subscription delivers real backend changes',
      )
      await subscription.close()
      assert.equal(await subscription.closed, 'local')
      const count = changes.length
      await delay(200)
      assert.equal(
        changes.length,
        count,
        'closed subscription delivers no more changes',
      )
      assert.deepEqual(
        (
          await peer.readResource(
            { uri: 'note://still-healthy' },
            { timeout: requestTimeout(3000) },
          )
        ).contents,
        [{ uri: 'note://still-healthy', text: 'resource body' }],
      )
    },
  )
}
