import assert from 'node:assert/strict'
import { knownBugTest } from './helpers/known-bug.js'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

knownBugTest(
  'GW-004',
  'stateful HTTP survives an unsolicited response and serves the valid request',
  { timeout: 15000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/interleaving-mcp-peer.mjs --stale-response',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const init = await rpc(url, initialize())
    assert.equal(init.response.status, 200)
    const session = init.response.headers.get('mcp-session-id')
    assert.ok(session)
    for (const id of [2, 3]) {
      const result: Awaited<ReturnType<typeof rpc>> = await rpc(
        url,
        { jsonrpc: '2.0', id, method: 'tools/list' },
        session,
      ).catch((cause) => {
        throw new Error(gateway.errors(), { cause })
      })
      assert.equal(result.response.status, 200)
      assert.deepEqual(
        result.messages.filter((message) => message.id === id),
        [{ jsonrpc: '2.0', id, result: { tools: [] } }],
      )
    }
    assert.equal(gateway.child.exitCode, null)
  },
)
