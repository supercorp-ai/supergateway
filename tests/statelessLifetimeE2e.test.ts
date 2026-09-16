import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { faultControl } from './helpers/fault-control.js'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

function alive(pid: number) {
  try {
    return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    })
      .trim()
      .startsWith('Z')
  } catch (error) {
    if ((error as { status: number }).status === 1) return false
    throw error
  }
}
async function stopped(pid: number, ms = 2500) {
  const deadline = Date.now() + ms
  while (alive(pid) && Date.now() < deadline) await delay(20)
  assert.equal(alive(pid), false, `completed request left peer ${pid} alive`)
}
async function setup(
  t: import('node:test').TestContext,
  env: Record<string, string> = {},
) {
  const control = await faultControl(t)
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      'exec node tests/helpers/stateless-lifetime-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ],
    { LIFETIME_CONTROL: control.url, ...env },
  )
  await gateway.ready()
  return { control, gateway, url: `http://127.0.0.1:${port}/mcp` }
}
const call = (id: string | number, name: string) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
})
const pidFrom = (message: any) =>
  Number(
    message.result?.serverInfo?.version ??
      message.result?.content[0].text ??
      message.error.message,
  )

test(
  'stateless successful and error replies release each request child, including ID zero',
  { timeout: 20000 },
  async (t) => {
    const b = await setup(t)
    for (const message of [
      initialize(0),
      call('same-id', 'identity'),
      call('same-id', 'error'),
      call('large', 'large'),
      call('last', 'identity'),
    ]) {
      const reply = await rpc(b.url, message)
      assert.equal(reply.response.status, 200)
      assert.equal(reply.messages.length, 1)
      assert.equal(reply.messages[0].id, message.id)
      if (message.id === 'large')
        assert.equal(
          reply.messages[0].result.content[1].text,
          'x'.repeat(512 * 1024),
          'cleanup preserves the complete buffered response',
        )
      const pid = pidFrom(reply.messages[0])
      assert.ok(pid > 0)
      await stopped(pid)
    }
    assert.equal(b.gateway.child.exitCode, null)
  },
)

test(
  'stateless completion preserves concurrent in-flight work with the same request ID',
  { timeout: 20000 },
  async (t) => {
    const b = await setup(t)
    const first = rpc(b.url, call('shared', 'hold'))
    void first.catch(() => {})
    const heldFirst = await b.control.wait('hold')
    const second = rpc(b.url, call('shared', 'hold'))
    void second.catch(() => {})
    const deadline = Date.now() + 4000
    while (
      b.control.events.filter((event) => event.kind === 'hold').length < 2 &&
      Date.now() < deadline
    )
      await delay(10)
    const holds = b.control.events.filter((event) => event.kind === 'hold')
    assert.equal(holds.length, 2)
    const heldSecond = holds[1]
    assert.notEqual(heldFirst.pid, heldSecond.pid)
    assert.equal(alive(heldFirst.pid), true)
    assert.equal(alive(heldSecond.pid), true)
    heldFirst.response.end('release')
    assert.equal(pidFrom((await first).messages[0]), heldFirst.pid)
    await stopped(heldFirst.pid)
    assert.equal(alive(heldSecond.pid), true)
    heldSecond.response.end('release')
    assert.equal(pidFrom((await second).messages[0]), heldSecond.pid)
    await stopped(heldSecond.pid)
  },
)

test(
  'stateless disconnect preserves in-flight work and releases the child after its reply',
  { timeout: 20000 },
  async (t) => {
    const b = await setup(t)
    const abort = new AbortController()
    const request = fetch(b.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(call('disconnected', 'hold')),
      signal: abort.signal,
    }).then((response) => response.text())
    const rejected = assert.rejects(request, { name: 'AbortError' })
    const held = await b.control.wait('hold')
    abort.abort()
    await rejected
    await delay(100)
    assert.equal(alive(held.pid), true, 'disconnect is not cancellation')
    const healthy = await rpc(b.url, call('healthy', 'identity'))
    await stopped(pidFrom(healthy.messages[0]))
    assert.equal(alive(held.pid), true, 'another request cannot stop this peer')
    held.response.end('release')
    await b.control.wait('completed', held.pid)
    await stopped(held.pid)
    assert.equal(b.gateway.child.exitCode, null)
  },
)

test(
  'stateless HTTP 202 preserves notification delivery before bounded stdin shutdown',
  { timeout: 20000 },
  async (t) => {
    const b = await setup(t, { LIFETIME_INIT_HOLD: '1' })
    const reply = await rpc(b.url, {
      jsonrpc: '2.0',
      method: 'notifications/test',
    })
    assert.equal(reply.response.status, 202)
    assert.deepEqual(reply.messages, [])
    const initializing = await b.control.wait('hold')
    await delay(100)
    assert.equal(alive(initializing.pid), true)
    initializing.response.end('release')
    const delivered = await b.control.wait('delivered', initializing.pid)
    assert.equal(delivered.query.get('method'), 'notifications/test')
    assert.equal(
      alive(initializing.pid),
      true,
      'notification receives an EOF grace period',
    )
    await stopped(initializing.pid, 6500)
    assert.equal(b.gateway.child.exitCode, null)
  },
)
