import { knownBugTest } from './helpers/known-bug.js'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'

for (const protocol of ['sse', 'streamableHttp']) {
  knownBugTest(
    'GW-002',
    `${protocol} bridge preserves an error-named field inside a successful result`,
    { timeout: 15000 },
    async (t) => {
      const port = await unusedPort()
      const upstream = launchGateway(t, [
        '--stdio',
        'node tests/helpers/noisy-mcp-server.js stdio',
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
      await stdioRpc(bridge, { ...initialize(), id: 1 })
      const response = await stdioRpc(bridge, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'diagnostic', arguments: {} },
      })
      assert.equal(
        response.error,
        undefined,
        'application data must not become a protocol error',
      )
      assert.deepEqual(response.result, {
        content: [{ type: 'text', text: 'completed with diagnostic data' }],
        error: { code: 123, message: 'application diagnostic' },
      })
    },
  )
}
