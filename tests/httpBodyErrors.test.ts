import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

// Bodies express.json() rejects used to get Express's HTML error page, which
// no JSON-RPC client can read and which, unless NODE_ENV was `production`,
// carried the stack trace with the server's absolute file paths.
for (const stateful of [false, true]) {
  test(
    `${stateful ? 'stateful' : 'stateless'} HTTP answers a rejected body as JSON-RPC, not HTML`,
    { timeout: 30000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        ...(stateful ? ['--stateful'] : []),
      ])
      await gateway.ready()
      const post = async (body: string, contentType = 'application/json') => {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': contentType,
            accept: 'application/json, text/event-stream',
          },
          body,
          signal: AbortSignal.timeout(5000),
        })
        const text = await response.text()
        assert.doesNotMatch(text, /<html|node_modules|at JSON\.parse/i)
        assert.match(response.headers.get('content-type')!, /application\/json/)
        return { status: response.status, body: JSON.parse(text) }
      }

      assert.deepEqual(await post('{nope'), {
        status: 400,
        body: {
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error: invalid JSON' },
          id: null,
        },
      })
      const charset = await post('{}', 'application/json; charset=latin9')
      assert.equal(charset.status, 415)
      assert.equal(charset.body.error.code, -32000)
      const tooLarge = await post(
        JSON.stringify({ pad: 'x'.repeat(4 * 1024 * 1024) }),
      )
      assert.equal(tooLarge.status, 413)
      assert.equal(tooLarge.body.error.code, -32000)
    },
  )
}
