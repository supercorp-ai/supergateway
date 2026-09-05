import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

for (const protocol of ['sse', 'streamableHttp']) {
  for (const fallback of [false, true]) {
    test(
      `${protocol} exits cleanly when upstream rejects ${fallback ? 'fallback' : 'explicit'} initialization`,
      { timeout: 15000 },
      async (t) => {
        const port = await unusedPort()
        const upstream = launchGateway(t, [
          '--stdio',
          'node tests/helpers/interleaving-mcp-peer.mjs --reject-initialize',
          '--outputTransport',
          protocol,
          '--port',
          String(port),
          ...(protocol === 'streamableHttp' ? ['--stateful'] : []),
        ])
        await upstream.ready()
        const bridge = launchGateway(t, [
          `--${protocol}`,
          `http://127.0.0.1:${port}/${protocol === 'sse' ? 'sse' : 'mcp'}`,
        ])
        await bridge.ready()
        bridge.child.stdin.write(
          JSON.stringify(
            fallback
              ? { jsonrpc: '2.0', id: 1, method: 'tools/list' }
              : initialize(),
          ) + '\n',
        )
        const result = await bridge.exited
        assert.equal(result.code, 1)
        assert.equal(result.signal, null)
        assert.match(bridge.errors(), /connection closed/)
        assert.doesNotMatch(
          bridge.errors(),
          /TypeError|UnhandledPromiseRejection/,
        )
        await upstream.waitFor(
          () => upstream.output().includes('Initialization unavailable'),
          'report the upstream initialization rejection',
        )
      },
    )
  }
}

test(
  'stateless HTTP tolerates notifications before automatic initialization completes',
  { timeout: 15000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/interleaving-mcp-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    for (const id of [1, 2]) {
      const result = await rpc(`http://127.0.0.1:${port}/mcp`, {
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
      })
      assert.equal(result.response.status, 200)
      assert.deepEqual(
        result.messages.filter((message) => message.id === id),
        [{ jsonrpc: '2.0', id, result: { tools: [] } }],
      )
    }
    await gateway.waitFor(
      () => gateway.output().includes('initializing'),
      'observe the interleaved peer notification',
    )
    assert.equal(gateway.child.exitCode, null)
  },
)
