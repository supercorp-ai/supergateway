import assert from 'node:assert/strict'
import { knownBugTest } from './helpers/known-bug.js'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

for (const method of ['POST', 'GET', 'DELETE']) {
  knownBugTest(
    'GW-008',
    `stateful HTTP rejects an inherited-property session ID for ${method}`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--stateful',
        '--port',
        String(port),
        '--healthEndpoint',
        '/health',
      ])
      await gateway.ready()
      const base = `http://127.0.0.1:${port}`
      const response = await fetch(base + '/mcp', {
        method,
        signal: AbortSignal.timeout(3000),
        headers: {
          'mcp-session-id': 'constructor',
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        ...(method === 'POST'
          ? {
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
            }
          : {}),
      }).catch((cause) => {
        throw new Error(gateway.errors(), { cause })
      })
      assert.equal(response.status, 400)
      await response.text()
      const health = await fetch(base + '/health', {
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(health.status, 200)
      assert.equal(await health.text(), 'ok')
      assert.equal(gateway.child.exitCode, null)
    },
  )
}
