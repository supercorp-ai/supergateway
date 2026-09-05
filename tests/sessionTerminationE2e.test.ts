import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'
import { lifecycleControl, pendingRpc } from './helpers/lifecycle-control.js'

test(
  'stateful DELETE settles active streams and tool work without stale idle cleanup',
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
    assert.ok(session)
    const abort = new AbortController()
    t.after(() => abort.abort())
    const stream = await fetch(url, {
      headers: { 'mcp-session-id': session, accept: 'text/event-stream' },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    })
    assert.equal(stream.status, 200)
    const streamEnded = stream.text().then(
      (text) => ({ text, error: undefined }),
      (error: Error) => ({ text: undefined, error }),
    )
    const pending = pendingRpc(
      t,
      url,
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'hold', arguments: {} },
      },
      session,
    )
    const held = await control.started
    const peerDisconnected = once(held, 'close')
    const deleted = await fetch(url, {
      method: 'DELETE',
      headers: { 'mcp-session-id': session },
      signal: AbortSignal.timeout(3000),
    })
    assert.equal(deleted.status, 200)
    await deleted.text()
    const ended = await pending.settled
    if (ended.kind === 'error')
      assert.notEqual(ended.error.name, 'TimeoutError')
    else assert.equal(ended.text.includes('held result'), false)
    assert.notEqual((await streamEnded).error?.name, 'TimeoutError')
    await peerDisconnected
    assert.equal(
      held.writableEnded,
      false,
      'deletion stops work without test release',
    )
    await delay(600)
    assert.doesNotMatch(
      gateway.output(),
      new RegExp(`Session ${session} timed out`),
    )
    assert.equal((await rpc(url, initialize(3), session)).response.status, 400)
    const fresh = await rpc(url, initialize(4))
    assert.equal(fresh.response.status, 200)
    assert.notEqual(fresh.response.headers.get('mcp-session-id'), session)
    assert.equal(
      fresh.messages.find((message) => message.id === 4).result.serverInfo.name,
      'lifecycle-peer',
    )
    assert.equal(gateway.child.exitCode, null)
  },
)
