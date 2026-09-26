import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// `--header` sets response headers. In SSE mode it reached every response; in
// both Streamable HTTP modes it reached only the health endpoint, so the MCP
// responses a client or proxy actually sees never carried it.
for (const stateful of [false, true]) {
  test(
    `${stateful ? 'stateful' : 'stateless'} HTTP sends --header on MCP responses, not only health`,
    { timeout: 20000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        '--healthEndpoint',
        '/health',
        '--header',
        'X-Deployment: blue',
        ...(stateful ? ['--stateful'] : []),
      ])
      await gateway.ready()
      const base = `http://127.0.0.1:${port}`
      const health = await fetch(`${base}/health`)
      await health.text()
      const init = await rpc(`${base}/mcp`, initialize())
      assert.equal(init.response.status, 200)
      const rejected = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: '{nope',
      })
      await rejected.text()
      for (const [label, response] of [
        ['health', health],
        ['initialize', init.response],
        ['a rejected body', rejected],
      ] as const)
        assert.equal(response.headers.get('x-deployment'), 'blue', label)
    },
  )
}
