// Manual regression reproducer, intentionally outside npm test's *.test.ts
// glob until the product bug is fixed. Run with Node 24 after npm run build:
// node tests/helpers/reproduce-bridge-fallback.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchGateway, peerCommand, unusedPort } from './gateway-process.ts'

for (const protocol of ['sse', 'streamableHttp']) {
  test(
    `${protocol} fallback forwards the first request after auto-initialization`,
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
      const bridge = launchGateway(t, [
        `--${protocol}`,
        `http://127.0.0.1:${port}/${protocol === 'sse' ? 'sse' : 'mcp'}`,
      ])
      await bridge.ready()
      bridge.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
      )
      const response = () =>
        bridge
          .output()
          .split('\n')
          .slice(0, -1)
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line))
          .find((message) => message.id === 1)
      await bridge.waitFor(
        () => Boolean(response()),
        'answer the first request using its fallback client',
      )
      assert.ok(response().result.tools.some((tool) => tool.name === 'add'))
    },
  )
}
