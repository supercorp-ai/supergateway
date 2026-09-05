import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

test(
  'stateless HTTP does not invent replies for notifications and remains usable',
  { timeout: 15000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const { id: _id, ...initializeNotification } = initialize()
    // Even an unexpected method in a notification must not acquire a made-up
    // request ID or produce a JSON-RPC response. This does not claim that an
    // initialize-shaped notification constitutes a valid MCP handshake.
    for (const notification of [
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      initializeNotification,
    ]) {
      const result = await rpc(url, notification)
      assert.equal(result.response.status, 202)
      assert.deepEqual(result.messages, [])
    }
    const later = await rpc(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })
    assert.equal(later.response.status, 200)
    assert.ok(
      later.messages
        .find((message) => message.id === 3)
        .result.tools.some((tool: { name: string }) => tool.name === 'add'),
    )
    assert.equal(gateway.child.exitCode, null)
  },
)
