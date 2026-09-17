import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableFakeTimers } from './helpers/fake-timers.js'
import { RetainedChildren } from '../src/lib/retainedChildren.js'

// The retention map only needs the transport's handler slots and `close`.
class FakeChild {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: unknown) => void
  closes = 0
  fail?: Error
  async close() {
    this.closes++
    this.onclose?.()
    if (this.fail) throw this.fail
  }
}
const child = () => new FakeChild()
const cast = (fake: FakeChild) => fake as any
function setup(overrides: { idleMs?: number; limit?: number } = {}) {
  const errors: unknown[][] = []
  const retained = new RetainedChildren({
    idleMs: overrides.idleMs ?? 1000,
    limit: overrides.limit ?? 3,
    logger: { info() {}, error: (...args) => errors.push(args) },
  })
  return { retained, errors }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('a kept child comes back for its own token exactly once, with handlers cleared', async () => {
  const { retained } = setup()
  const first = child()
  retained.keep('token', cast(first))
  assert.equal(retained.size, 1)
  assert.equal(typeof first.onmessage, 'function')
  assert.equal(await retained.take('token'), first)
  assert.equal(retained.size, 0)
  assert.equal(first.onmessage, undefined)
  assert.equal(first.onerror, undefined)
  assert.equal(first.onclose, undefined)
  assert.equal(await retained.take('token'), undefined)
  assert.equal(first.closes, 0)
})

test('an unknown token yields nothing', async () => {
  const { retained } = setup()
  assert.equal(await retained.take('never minted'), undefined)
})

test('an idle child is closed when the timeout elapses and not before', async (t) => {
  enableFakeTimers(t)
  const { retained } = setup({ idleMs: 500 })
  const first = child()
  retained.keep('token', cast(first))
  t.mock.timers.tick(499)
  assert.equal(first.closes, 0)
  assert.equal(retained.size, 1)
  t.mock.timers.tick(1)
  assert.equal(first.closes, 1)
  assert.equal(retained.size, 0)
  assert.equal(await retained.take('token'), undefined)
})

test('taking a child cancels its expiry', async (t) => {
  enableFakeTimers(t)
  const { retained } = setup({ idleMs: 500 })
  const first = child()
  retained.keep('token', cast(first))
  assert.equal(await retained.take('token'), first)
  t.mock.timers.tick(5000)
  assert.equal(first.closes, 0)
})

test('two children minting the same token are both released', async () => {
  const { retained } = setup()
  const first = child()
  const second = child()
  retained.keep('same', cast(first))
  retained.keep('same', cast(second))
  assert.equal(retained.size, 0)
  assert.equal(first.closes, 1)
  assert.equal(second.closes, 1)
  assert.equal(await retained.take('same'), undefined)
})

test('the same child can be kept again under a token it minted before', async () => {
  const { retained } = setup()
  const first = child()
  retained.keep('same', cast(first))
  assert.equal(await retained.take('same'), first)
  retained.keep('same', cast(first))
  assert.equal(retained.size, 1)
  assert.equal(first.closes, 0)
  assert.equal(await retained.take('same'), first)
})

test('the oldest child is released when the limit is reached', async () => {
  const { retained } = setup({ limit: 2 })
  const children = [child(), child(), child()]
  children.forEach((fake, index) => retained.keep(`t${index}`, cast(fake)))
  assert.equal(retained.size, 2)
  assert.deepEqual(
    children.map((fake) => fake.closes),
    [1, 0, 0],
  )
  assert.equal(await retained.take('t0'), undefined)
  assert.equal(await retained.take('t1'), children[1])
  assert.equal(await retained.take('t2'), children[2])
})

test('a child that exits or fails while kept is dropped', async () => {
  const { retained } = setup()
  const exited = child()
  const failed = child()
  retained.keep('exited', cast(exited))
  retained.keep('failed', cast(failed))
  exited.onclose!()
  failed.onerror!(new Error('pipe broke'))
  assert.equal(retained.size, 0)
  assert.equal(await retained.take('exited'), undefined)
  assert.equal(await retained.take('failed'), undefined)
})

test('output between rounds is ignored', async () => {
  const { retained } = setup()
  const first = child()
  retained.keep('token', cast(first))
  assert.doesNotThrow(() =>
    first.onmessage!({ jsonrpc: '2.0', method: 'notifications/message' }),
  )
  assert.equal(await retained.take('token'), first)
})

test('close releases every kept child and later keeps close immediately', async (t) => {
  enableFakeTimers(t)
  const { retained } = setup()
  const kept = [child(), child()]
  kept.forEach((fake, index) => retained.keep(`t${index}`, cast(fake)))
  await retained.close()
  assert.equal(retained.size, 0)
  assert.deepEqual(
    kept.map((fake) => fake.closes),
    [1, 1],
  )
  const late = child()
  retained.keep('late', cast(late))
  assert.equal(retained.size, 0)
  assert.equal(late.closes, 1)
  t.mock.timers.tick(10000)
  assert.deepEqual(
    kept.map((fake) => fake.closes),
    [1, 1],
  )
})

test('a failing close is logged, not thrown', async (t) => {
  enableFakeTimers(t)
  const { retained, errors } = setup({ idleMs: 10 })
  const first = child()
  first.fail = new Error('private close failure')
  retained.keep('token', cast(first))
  t.mock.timers.tick(10)
  await tick()
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], first.fail)
  const second = child()
  second.fail = new Error('private shutdown failure')
  retained.keep('second', cast(second))
  await retained.close()
  assert.equal(errors.length, 2)
})

test('a continuation waits for an exchange that is still parking its child', async () => {
  const { retained } = setup()
  const first = child()
  const settle = retained.reserve('token')
  let taken: unknown = 'pending'
  const waiting = retained.take('token').then((result) => (taken = result))
  await tick()
  assert.equal(taken, 'pending')
  retained.keep('token', cast(first))
  settle()
  await waiting
  assert.equal(taken, first)
})

test('a continuation stops waiting when the parking exchange released its child instead', async () => {
  const { retained } = setup()
  const settleA = retained.reserve('token')
  const settleB = retained.reserve('token')
  const waiting = retained.take('token')
  settleA()
  settleA()
  let taken: unknown = 'pending'
  void waiting.then((result) => (taken = result))
  await tick()
  assert.equal(taken, 'pending', 'one of two exchanges is still parking')
  settleB()
  assert.equal(await waiting, undefined)
  assert.equal(retained.size, 0)
})
