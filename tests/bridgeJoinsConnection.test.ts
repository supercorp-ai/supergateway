import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  gatewayTimeout,
  launchGateway,
  listening,
  unusedPort,
} from './helpers/gateway-process.js'

// The Streamable HTTP→stdio bridge connects upstream when its first request
// arrives. One that arrives while that connection is still being made waits
// for it, and is answered on it: it does not start a second, and does not go
// ahead without one.

test(
  'a request that reaches the bridge while it is connecting is answered once it has',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const port = await unusedPort()
    const upstream = spawn(
      'node',
      ['tests/helpers/mock-mcp-server.js', 'streamableHttp'],
      {
        env: { ...process.env, PORT: String(port) },
        stdio: 'ignore',
      },
    )
    t.after(async () => {
      upstream.kill('SIGKILL')
      await once(upstream, 'exit')
    })
    await listening(port)
    const bridge = launchGateway(t, [
      '--streamableHttp',
      `http://localhost:${port}/mcp`,
    ])
    // Both in one write: the second is read while the first is connecting.
    bridge.child.stdin.write(
      [
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1' },
          },
        },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ]
        .map((message) => `${JSON.stringify(message)}\n`)
        .join(''),
    )
    const answers = () =>
      bridge
        .output()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
    await bridge.waitFor(() => answers().length === 2, 'answer both requests')
    const byId = Object.fromEntries(answers().map((a) => [a.id, a]))
    assert.equal(byId[1].result.serverInfo.name.length > 0, true)
    assert.equal(byId[2].error, undefined)
    assert.ok(
      byId[2].result.tools.some(
        (tool: { name: string }) => tool.name === 'add',
      ),
    )
    // One connection: nothing was started beside it.
    assert.equal(
      bridge
        .errors()
        .split('\n')
        .filter((line) => /connected/i.test(line)).length,
      1,
      bridge.errors(),
    )
  },
)
