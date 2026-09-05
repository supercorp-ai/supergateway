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
  'stateless HTTP handles zero IDs and interleaved notifications without losing responses',
  { timeout: 15000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/interleaving-mcp-peer.mjs --stale-response',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const init = await rpc(url, initialize(0))
    assert.equal(init.response.status, 200)
    assert.equal(
      init.messages.find((message) => message.id === 0).result.serverInfo.name,
      'interleaving-peer',
    )
    // A fresh stateless request uses auto-initialization; a notification before
    // that reply must not be mistaken for completion of the handshake.
    for (const id of [1, 2]) {
      const result = await rpc(url, {
        jsonrpc: '2.0',
        id,
        method: 'tools/list',
      })
      assert.equal(result.response.status, 200)
      assert.deepEqual(
        result.messages.find((message) => message.id === id).result,
        { tools: [] },
      )
      assert.equal(
        result.messages.filter((message) => message.id === 'stale-peer-request')
          .length,
        0,
      )
    }
    await gateway.waitFor(
      () => gateway.errors().includes('Failed to send to StreamableHttp'),
      'report stale response without crashing',
    )
    assert.equal(gateway.child.exitCode, null)
  },
)

test(
  'stateless HTTP forwards every request in a batch after one initialization',
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
    const result = await rpc(`http://127.0.0.1:${port}/mcp`, [
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'add', arguments: { a: 2, b: 3 } },
      },
      {
        jsonrpc: '2.0',
        id: 11,
        method: 'tools/call',
        params: { name: 'add', arguments: { a: 4, b: 5 } },
      },
    ]).catch((error) => {
      throw new Error(gateway.output() + gateway.errors(), { cause: error })
    })
    assert.equal(result.response.status, 200)
    assert.equal(result.messages.length, 2)
    assert.equal(
      result.messages.find((message) => message.id === 10).result.content[0]
        .text,
      'The sum of 2 and 3 is 5.',
    )
    assert.equal(
      result.messages.find((message) => message.id === 11).result.content[0]
        .text,
      'The sum of 4 and 5 is 9.',
    )
  },
)
