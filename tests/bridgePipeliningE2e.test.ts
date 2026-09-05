import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  peerCommand,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'

for (const protocol of ['sse', 'streamableHttp']) {
  test(
    `${protocol} keeps pipelined startup replies isolated and remains usable`,
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
      // A well-behaved client waits for initialization. A premature request
      // must still not corrupt the handshake or poison subsequent requests.
      bridge.child.stdin.write(
        [initialize(1), { jsonrpc: '2.0', id: 2, method: 'tools/list' }]
          .map((message) => JSON.stringify(message) + '\n')
          .join(''),
      )
      const responses = () =>
        bridge
          .output()
          .split('\n')
          .slice(0, -1)
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line))
      await bridge.waitFor(
        () =>
          [1, 2].every((id) =>
            responses().some((message) => message.id === id),
          ),
        'answer both pipelined requests',
      )
      const messages = responses()
      assert.equal(messages.filter((message) => message.id === 1).length, 1)
      assert.equal(messages.filter((message) => message.id === 2).length, 1)
      const init = messages.find((message) => message.id === 1)
      assert.equal(init.error, undefined)
      assert.equal(init.result.serverInfo.name, 'mock-server')
      assert.equal(
        init.result.protocolVersion,
        initialize().params.protocolVersion,
      )
      const early = messages.find((message) => message.id === 2)
      // Scheduling may allow this request to succeed. Either a normal result
      // or a properly correlated rejection is acceptable; mixed payloads aren't.
      if (early.error) {
        assert.equal(early.result, undefined)
        assert.equal(early.error.code, -32000)
        assert.equal(typeof early.error.message, 'string')
        assert.ok(early.error.message.length > 0)
      } else {
        assert.ok(
          early.result.tools.some(
            (tool: { name: string }) => tool.name === 'add',
          ),
        )
      }
      const later = await stdioRpc(bridge, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      })
      assert.equal(later.error, undefined)
      assert.ok(
        later.result.tools.some(
          (tool: { name: string }) => tool.name === 'add',
        ),
      )
      assert.equal(bridge.child.exitCode, null)
    },
  )
}
