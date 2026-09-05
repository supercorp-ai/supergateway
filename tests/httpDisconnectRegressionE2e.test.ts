import assert from 'node:assert/strict'
import { knownBugTest } from './helpers/known-bug.js'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'
import { lifecycleControl, pendingRpc } from './helpers/lifecycle-control.js'

for (const stateful of [false, true]) {
  knownBugTest(
    'GW-004',
    `${stateful ? 'stateful' : 'stateless'} HTTP survives a legitimate reply after its client disconnects`,
    { timeout: 15000 },
    async (t) => {
      const control = await lifecycleControl(t)
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        control.peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        '--healthEndpoint',
        '/health',
        ...(stateful ? ['--stateful'] : []),
      ])
      await gateway.ready()
      const base = `http://127.0.0.1:${port}`
      const session = stateful
        ? (await rpc(base + '/mcp', initialize())).response.headers.get(
            'mcp-session-id',
          )!
        : undefined
      const pending = pendingRpc(
        t,
        base + '/mcp',
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'hold', arguments: {} },
        },
        session,
      )
      const held = await control.started
      pending.abort()
      assert.equal((await pending.settled).kind, 'error')
      if (stateful)
        await gateway.waitFor(
          () => gateway.output().includes(`Response closed ${session}`),
          'observe the aborted HTTP request',
        )
      // A completed health roundtrip confirms the gateway remains responsive
      // after disconnect, before the actual MCP tool is allowed to finish.
      const before = await fetch(base + '/health', {
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(before.status, 200)
      await before.text()
      held.end('release')
      await gateway.waitFor(
        () => gateway.output().includes('held result'),
        'process the legitimate late reply',
      )
      const next = await rpc(
        base + '/mcp',
        { jsonrpc: '2.0', id: 3, method: 'tools/list' },
        session,
      ).catch((cause) => {
        throw new Error(gateway.errors(), { cause })
      })
      assert.equal(next.response.status, 200)
      assert.ok(
        next.messages
          .find((message) => message.id === 3)
          .result.tools.some((tool: { name: string }) => tool.name === 'hold'),
      )
      assert.equal(gateway.child.exitCode, null)
    },
  )
}
