import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { knownBugTest } from './helpers/known-bug.js'
import {
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

for (const days of [1, 30]) {
  const runTest = days === 1 ? test : knownBugTest.bind(undefined, 'GW-010')
  runTest(
    `stateful HTTP honors a ${days}-day idle timeout without expiring immediately`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--stateful',
        '--sessionTimeout',
        String(days * 24 * 60 * 60 * 1000),
        '--port',
        String(port),
      ])
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      const session = (await rpc(url, initialize())).response.headers.get(
        'mcp-session-id',
      )!
      assert.ok(session)
      await delay(100)
      const later = await rpc(
        url,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        session,
      )
      assert.equal(later.response.status, 200, gateway.errors())
      assert.ok(
        later.messages
          .find((message) => message.id === 2)
          .result.tools.some((tool: { name: string }) => tool.name === 'add'),
      )
      assert.equal(gateway.child.exitCode, null)
    },
  )
}
