// A first non-initialize request uses the gateway's fallback initialization.
// Exercise that compatibility path with real CLI processes and SDK peers.
import { knownBugTest } from './helpers/known-bug.js'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

for (const protocol of ['sse', 'streamableHttp']) {
  for (const firstMethod of ['tools/list', 'audit/unknown']) {
    knownBugTest(
      'GW-001',
      `${protocol} fallback forwards ${firstMethod} after auto-initialization`,
      { timeout: 15000 },
      async (t) => {
        const port = await unusedPort()
        const upstream = launchGateway(t, [
          '--stdio',
          peerCommand,
          '--outputTransport',
          protocol,
          '--port',
          String(port),
          ...(protocol === 'streamableHttp' ? ['--stateful'] : []),
        ])
        await upstream.ready()
        assert.match(upstream.output(), /Headers: \(none\)/)
        const bridge = launchGateway(t, [
          `--${protocol}`,
          `http://127.0.0.1:${port}/${protocol === 'sse' ? 'sse' : 'mcp'}`,
        ])
        await bridge.ready()
        bridge.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: 1, method: firstMethod }) + '\n',
        )
        const response = (id: number) =>
          bridge
            .output()
            .split('\n')
            .slice(0, -1)
            .filter((line) => line.startsWith('{'))
            .map((line) => JSON.parse(line))
            .find((message) => message.id === id)
        await bridge.waitFor(
          () => Boolean(response(1)),
          'answer the first request using its fallback client',
        )
        if (firstMethod === 'tools/list') {
          assert.ok(
            response(1).result.tools.some(
              (tool: { name: string }) => tool.name === 'add',
            ),
          )
        } else {
          assert.equal(response(1).error.code, -32601)
          assert.equal(response(1).error.message, 'Method not found')
        }
        bridge.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) +
            '\n',
        )
        await bridge.waitFor(
          () => Boolean(response(2)),
          'answer a subsequent request',
        )
        assert.ok(
          response(2).result.tools.some(
            (tool: { name: string }) => tool.name === 'add',
          ),
        )
      },
    )
  }
}
