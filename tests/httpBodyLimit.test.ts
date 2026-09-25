import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// Issue #163: the HTTP modes used express's 100 kB JSON default, so large
// tool arguments were refused with 413 while SSE mode, which parses with
// the SDK, accepted them. Both HTTP modes now share the SDK's 4 MB ceiling.
for (const stateful of [false, true]) {
  test(
    `${stateful ? 'stateful' : 'stateless'} HTTP accepts messages up to 4 MB, like SSE`,
    { timeout: 30000 },
    async (t) => {
      const port = await unusedPort()
      const url = `http://127.0.0.1:${port}/mcp`
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
      const init = await rpc(url, initialize())
      assert.equal(init.response.status, 200)
      const session = init.response.headers.get('mcp-session-id') ?? undefined

      const call = (pad: number) => ({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'add',
          arguments: { a: 1, b: 2, pad: 'x'.repeat(pad) },
        },
      })
      // 1 MB: ten times the old limit. The answer comes from the child, so
      // the whole body was parsed and relayed, not just accepted.
      const large = await rpc(url, call(1024 * 1024), session)
      assert.equal(large.response.status, 200)
      assert.equal(
        large.messages[0].result.content[0].text,
        'The sum of 1 and 2 is 3.',
      )

      // Past 4 MB the gateway still refuses before touching the child.
      const tooLarge = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(session ? { 'mcp-session-id': session } : {}),
        },
        body: JSON.stringify(call(4 * 1024 * 1024)),
      })
      assert.equal(tooLarge.status, 413)
      await tooLarge.text()
    },
  )
}
