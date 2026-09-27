import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'
import { descendantsOf } from './helpers/process-tree.js'

// A --streamableHttp bridge that exited left its session open on a stateful
// upstream, and with it that session's server process, until the upstream's
// session timeout (30 minutes by default). A desktop client restarting the
// bridge stranded one more process each time. It now ends the session.
const upstream = async (
  t: Parameters<typeof launchGateway>[0],
  stateful: boolean,
) => {
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
  return { gateway, url: `http://127.0.0.1:${port}/mcp` }
}

const bridgeTo = async (
  t: Parameters<typeof launchGateway>[0],
  url: string,
  connect: boolean,
) => {
  const bridge = launchGateway(t, ['--streamableHttp', url])
  await bridge.ready()
  if (connect) {
    bridge.child.stdin.write(JSON.stringify(initialize(1)) + '\n')
    await bridge.waitFor(
      () => bridge.output().includes('"id":1'),
      'initialize upstream',
    )
  }
  return bridge
}

test(
  'a bridge ends its stateful upstream session when it exits',
  { timeout: 30000 },
  async (t) => {
    const { gateway, url } = await upstream(t, true)
    const bridge = await bridgeTo(t, url, true)
    const children = () =>
      descendantsOf(gateway.child.pid!, { since: gateway.spawnedAt }).length
    assert.ok(children() > 0, 'the session has a server process')
    bridge.child.stdin.end()
    assert.equal((await bridge.exited).code, 0)
    await gateway.waitFor(() => children() === 0, 'end the bridge’s session')
  },
)

for (const [label, stateful, connect] of [
  ['a stateless upstream, which has no session', false, true],
  ['a bridge that never connected', true, false],
] as const)
  test(`${label} exits cleanly`, { timeout: 30000 }, async (t) => {
    const { url } = await upstream(t, stateful)
    const bridge = await bridgeTo(t, url, connect)
    bridge.child.stdin.end()
    assert.equal((await bridge.exited).code, 0)
    assert.doesNotMatch(bridge.errors(), /Failed to end the upstream session/)
  })

test(
  'a bridge whose upstream is gone still exits cleanly',
  { timeout: 30000 },
  async (t) => {
    const { gateway, url } = await upstream(t, true)
    const bridge = await bridgeTo(t, url, true)
    await gateway.dispose()
    bridge.child.stdin.end()
    assert.equal((await bridge.exited).code, 0)
    assert.match(bridge.errors(), /Failed to end the upstream session/)
  },
)
