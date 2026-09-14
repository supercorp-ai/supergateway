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

async function processExited(pid: number) {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      throw error
    }
    await delay(20)
  }
  return false
}

for (const ending of ['DELETE', 'idle timeout'] as const) {
  test(
    `stateful ${ending} terminates the actual stdio peer process`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        'node tests/helpers/lifecycle-identity-peer.mjs',
        '--outputTransport',
        'streamableHttp',
        '--stateful',
        '--sessionTimeout',
        ending === 'DELETE' ? '5000' : '200',
        '--port',
        String(port),
      ])
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      const initialized = await rpc(url, initialize())
      const session = initialized.response.headers.get('mcp-session-id')!
      const info = initialized.messages.find((message) => message.id === 1)
        .result.serverInfo
      assert.equal(info.name, 'lifecycle-identity-peer')
      const pid = Number(info.version)
      assert.ok(Number.isInteger(pid) && pid > 0)
      assert.doesNotThrow(
        () => process.kill(pid, 0),
        'the peer is alive before cleanup',
      )
      if (ending === 'DELETE') {
        const deleted = await fetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': session },
          signal: AbortSignal.timeout(3000),
        })
        assert.equal(deleted.status, 200)
        await deleted.text()
      }
      assert.equal(
        await processExited(pid),
        true,
        `${ending} must terminate the stdio peer, not just its connection`,
      )
      const expired = await rpc(url, initialize(2), session)
      assert.equal(expired.response.status, 400)
      const fresh = await rpc(url, initialize(3))
      assert.equal(fresh.response.status, 200)
      assert.notEqual(fresh.response.headers.get('mcp-session-id'), session)
      assert.equal(gateway.child.exitCode, null)
    },
  )
}

test(
  'WebSocket SIGTERM shuts down the gateway and its actual stdio peer',
  { timeout: 10000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/lifecycle-identity-peer.mjs',
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
    t.after(() => socket.terminate())
    await once(socket, 'open')
    const reply = once(socket, 'message')
    socket.send(JSON.stringify(initialize()))
    const info = JSON.parse(String((await reply)[0])).result.serverInfo
    assert.equal(info.name, 'lifecycle-identity-peer')
    const pid = Number(info.version)
    assert.ok(Number.isInteger(pid) && pid > 0)
    assert.doesNotThrow(
      () => process.kill(pid, 0),
      'the peer is alive before SIGTERM',
    )
    const closed = once(socket, 'close')
    gateway.child.kill('SIGTERM') // Only the gateway: a process-group signal would mask missing cleanup.
    assert.deepEqual(await gateway.exited, { code: 0, signal: null })
    await closed
    assert.equal(
      await processExited(pid),
      true,
      'gateway shutdown must terminate its stdio peer',
    )
  },
)
