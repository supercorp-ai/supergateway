import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  peerCommand,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'
import { faultControl } from './helpers/fault-control.js'

test(
  'Streamable HTTP to stdio bridge recovers after upstream restarts',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const args = [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ]
    const upstream = launchGateway(t, args)
    await upstream.ready()
    const bridge = launchGateway(t, [
      '--streamableHttp',
      `http://127.0.0.1:${port}/mcp`,
    ])
    await bridge.ready()
    assert.equal(
      (await stdioRpc(bridge, initialize(1))).result.serverInfo.name,
      'mock-server',
    )
    const before = await stdioRpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    assert.equal(before.result.tools[0].name, 'add')

    await upstream.dispose()
    const restarted = launchGateway(t, args)
    await restarted.ready()
    const interrupted = await stdioRpc(bridge, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })
    assert.ok(interrupted.error, 'the stale session reports an error')
    const recovered = await stdioRpc(bridge, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    })
    assert.equal(recovered.result.tools[0].name, 'add')
    assert.equal(bridge.child.exitCode, null)
  },
)

test(
  'an in-flight call returns an error when upstream disappears and is not replayed',
  { timeout: 30000 },
  async (t) => {
    const control = await faultControl(t)
    const port = await unusedPort()
    const args = [
      '--stdio',
      'exec node tests/helpers/fault-wrapper.mjs',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ]
    const env = { FAULT_CONTROL: control.url }
    const upstream = launchGateway(t, args, env)
    await upstream.ready()
    const bridge = launchGateway(t, [
      '--streamableHttp',
      `http://127.0.0.1:${port}/mcp`,
    ])
    await bridge.ready()
    assert.equal(
      (await stdioRpc(bridge, initialize(1))).result.serverInfo.name,
      'fault-peer',
    )
    const pending = stdioRpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'hold', arguments: {} },
    })
    await control.wait('hold')
    upstream.signal('SIGKILL')
    await upstream.exited
    const interrupted = await pending
    assert.ok(interrupted.error, 'the in-flight call receives a protocol error')
    assert.equal(bridge.child.exitCode, null)
    const restarted = launchGateway(t, args, env)
    await restarted.ready()
    const firstAfterRestart = await stdioRpc(bridge, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })
    const recovered = firstAfterRestart.error
      ? await stdioRpc(bridge, {
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/list',
        })
      : firstAfterRestart
    assert.equal(recovered.result.tools[0].name, 'identity')
    assert.equal(control.events.filter(({ kind }) => kind === 'hold').length, 1)
  },
)
