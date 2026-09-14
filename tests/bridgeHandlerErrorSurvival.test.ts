import test from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * What cluster A actually bought for the reverse bridges.
 *
 * Their `onmessage` handler dereferences `result` outside its own try/catch,
 * and the fallback path never assigns it — so a client whose *first* stdio
 * request is not `initialize` used to take the whole bridge down with an
 * unhandled rejection. Nothing survived to report it.
 *
 * GW-001 (`bridgeFallbackE2e.test.ts`) holds the real defect: that request
 * still gets no reply. This pins the separate, weaker property that is true
 * now — the bridge stays up, says what went wrong, and keeps serving — because
 * that is the guarantee the fix added and nothing else tests it. Without this
 * the handler is `function not called` in coverage: the crash gone, the
 * handler that replaced it unproven.
 */
for (const protocol of ['sse', 'streamableHttp'] as const) {
  test(
    `${protocol} bridge survives a handler error and keeps serving`,
    { timeout: 20000 },
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

      // A first request that is not `initialize` takes the fallback path.
      bridge.child.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n',
      )
      await bridge.waitFor(
        () =>
          /Unhandled error while handling a stdio message/.test(
            bridge.errors() + bridge.output(),
          ),
        'report the handler failure instead of dying on it',
      )

      assert.equal(
        bridge.child.exitCode,
        null,
        'the bridge is still running after the handler threw',
      )
      assert.equal(
        bridge.child.signalCode,
        null,
        'and was not killed by an unhandled rejection',
      )

      // Still serving: a well-formed exchange after the failure must work.
      bridge.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'e2e', version: '1.0.0' },
          },
        }) + '\n',
      )
      await bridge.waitFor(
        () =>
          bridge
            .output()
            .split('\n')
            .filter((line) => line.startsWith('{'))
            .map((line) => JSON.parse(line))
            .some((message) => message.id === 2),
        'answer a valid request after the failed one',
      )
    },
  )
}
