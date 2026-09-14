import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'
import { lifecycleControl, pendingRpc } from './helpers/lifecycle-control.js'

const tool = (id: number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
})

for (const stateful of [false, true]) {
  test(
    `${stateful ? 'stateful' : 'stateless'} HTTP closes a pending request after child exit and accepts a fresh client`,
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
      const pending = pendingRpc(t, base + '/mcp', tool(2, 'hold'), session)
      const held = await control.started
      held.end('exit')
      const ended = await pending.settled
      if (ended.kind === 'error')
        assert.notEqual(ended.error.name, 'TimeoutError')
      else assert.equal(ended.text.includes('held result'), false)
      await gateway.waitFor(
        () => gateway.errors().includes('Child exited: code=17'),
        'observe child exit',
      )
      const health = await fetch(base + '/health', {
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(health.status, 200)
      await health.text()
      if (session)
        assert.equal(
          (await rpc(base + '/mcp', tool(3, 'hold'), session)).response.status,
          400,
        )
      const fresh = await rpc(base + '/mcp', initialize(4))
      assert.equal(fresh.response.status, 200)
      assert.equal(
        fresh.messages.find((message) => message.id === 4).result.serverInfo
          .name,
        'lifecycle-peer',
      )
      if (session)
        assert.notEqual(fresh.response.headers.get('mcp-session-id'), session)
    },
  )
}

test(
  'WebSocket gateway propagates child failure while a request is pending',
  { timeout: 10000 },
  async (t) => {
    const control = await lifecycleControl(t)
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      control.peerCommand,
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
    t.after(() => socket.terminate())
    await once(socket, 'open')
    const initReply = once(socket, 'message')
    socket.send(JSON.stringify(initialize()))
    assert.equal(
      JSON.parse(String((await initReply)[0])).result.serverInfo.name,
      'lifecycle-peer',
    )
    const closed = once(socket, 'close')
    socket.send(JSON.stringify(tool(2, 'hold')))
    const held = await control.started
    held.end('exit')
    assert.equal((await gateway.exited).code, 17)
    await closed
  },
)

test(
  'stateful HTTP keeps active work alive then expires it after client disconnect',
  { timeout: 15000 },
  async (t) => {
    const control = await lifecycleControl(t)
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      control.peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '300',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const init = await rpc(url, initialize())
    const session = init.response.headers.get('mcp-session-id')!
    assert.ok(session)
    const pending = pendingRpc(t, url, tool(2, 'hold'), session)
    const held = await control.started
    const peerDisconnected = once(held, 'close')
    await delay(600) // Deliberately exceed the configured idle timeout.
    assert.doesNotMatch(
      gateway.output(),
      new RegExp(`Session ${session} timed out`),
    )
    const active = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      session,
    )
    assert.equal(active.response.status, 200)
    pending.abort()
    assert.equal((await pending.settled).kind, 'error')
    await gateway.waitFor(
      () => gateway.output().includes(`Session ${session} timed out`),
      'expire the disconnected session',
    )
    await peerDisconnected
    assert.equal(
      held.writableEnded,
      false,
      'the child exited without being released by the test',
    )
    assert.equal((await rpc(url, initialize(4), session)).response.status, 400)
    const fresh = await rpc(url, initialize(5))
    assert.equal(fresh.response.status, 200)
    assert.notEqual(fresh.response.headers.get('mcp-session-id'), session)
  },
)

test(
  'stateful HTTP cancels a pending idle timeout when the child exits',
  { timeout: 15000 },
  async (t) => {
    const control = await lifecycleControl(t)
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      control.peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '300',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const session = (await rpc(url, initialize())).response.headers.get(
      'mcp-session-id',
    )!
    const armed = await rpc(url, tool(2, 'armExit'), session)
    assert.equal(
      armed.messages.find((message) => message.id === 2).result.content[0].text,
      'exit armed',
    )
    const held = await control.started
    held.end('exit')
    await gateway.waitFor(
      () => gateway.errors().includes('Child exited: code=17'),
      'observe child exit before idle cleanup',
    )
    await delay(600)
    assert.doesNotMatch(
      gateway.output(),
      new RegExp(`Session ${session} timed out`),
    )
    assert.equal((await rpc(url, initialize(3), session)).response.status, 400)
    assert.equal((await rpc(url, initialize(4))).response.status, 200)
  },
)
