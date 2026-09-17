import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { enableFakeTimers } from './helpers/fake-timers.js'
import {
  RetainedChildren,
  isContinuationHandle,
} from '../src/lib/retainedChildren.js'
class FakeChild {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: unknown) => void
  closes = 0
  fail?: Error
  wait?: Promise<void>
  async close() {
    this.closes++
    this.onclose?.()
    await this.wait
    if (this.fail) throw this.fail
  }
}
const registries: RetainedChildren[] = []
afterEach(async () => {
  await Promise.all(registries.splice(0).map((r) => r.close()))
})
const cast = (child: FakeChild) => child as any
function setup(limit = 3) {
  const errors: unknown[][] = []
  const retained = new RetainedChildren({
    idleMs: 500,
    limit,
    logger: { info() {}, error: (...args) => errors.push(args) },
  })
  registries.push(retained)
  return { retained, errors }
}
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('handles distinguish equal and absent backend state and restore exact bytes', async () => {
  const { retained } = setup()
  const children = [new FakeChild(), new FakeChild(), new FakeChild()]
  const states = ['same/+=', 'same/+=', undefined]
  const handles = children.map((c, i) => retained.retain(states[i], cast(c)))
  assert.equal(new Set(handles).size, 3)
  assert.ok(handles.every(isContinuationHandle))
  assert.equal(isContinuationHandle('backend-state'), false)
  assert.equal(isContinuationHandle(undefined), false)
  await Promise.all(children.map((c) => retained.release(cast(c))))
  for (let i = 0; i < 3; i++) {
    assert.equal(typeof children[i].onmessage, 'function')
    children[i].onmessage!({ method: 'notifications/message' })
    assert.deepEqual(await retained.take(handles[i]), {
      child: children[i],
      state: states[i],
    })
    assert.equal(children[i].onmessage, undefined)
    assert.equal(children[i].onerror, undefined)
    assert.equal(children[i].onclose, undefined)
  }
  await retained.close()
  assert.equal(retained.size, 0)
  assert.deepEqual(
    children.map((c) => c.closes),
    [1, 1, 1],
  )
})

test('taking a handle waits for release and serializes concurrent retries', async () => {
  const { retained } = setup()
  const child = new FakeChild()
  const handle = retained.retain('signed', cast(child))
  let calls = 0
  const first = retained.take(handle).then((v) => {
    calls++
    return v
  })
  await tick()
  assert.equal(calls, 0)
  await retained.release(cast(child))
  assert.equal((await first)?.child, child)
  const second = retained.take(handle).then((v) => {
    calls++
    return v
  })
  await tick()
  assert.equal(calls, 1)
  await retained.release(cast(child))
  assert.equal((await second)?.child, child)
  assert.equal(calls, 2)
  assert.equal(child.closes, 0)
})

test('all historical handles route to their own state on one child', async () => {
  const { retained } = setup()
  const child = new FakeChild()
  const a = retained.retain('round1', cast(child))
  await retained.release(cast(child))
  await retained.take(a)
  const b = retained.retain('round2', cast(child))
  await retained.release(cast(child))
  assert.deepEqual(await retained.take(a), { child, state: 'round1' })
  await retained.release(cast(child))
  assert.deepEqual(await retained.take(b), { child, state: 'round2' })
  await retained.discard(cast(child))
  assert.equal(retained.size, 0)
  assert.equal(await retained.take(a), undefined)
  assert.equal(await retained.take(b), undefined)
})

test('idle expiry is suspended during a retry and reaps state and child afterwards', async (t) => {
  enableFakeTimers(t)
  const { retained } = setup()
  const child = new FakeChild()
  const handle = retained.retain('state', cast(child))
  await retained.release(cast(child))
  t.mock.timers.tick(499)
  assert.equal(child.closes, 0)
  await retained.take(handle)
  t.mock.timers.tick(5000)
  assert.equal(child.closes, 0)
  await retained.release(cast(child))
  t.mock.timers.tick(500)
  assert.equal(child.closes, 1)
  assert.equal(retained.size, 0)
  assert.equal(await retained.take(handle), undefined)
})

test('capacity evicts old states, closes idle unreferenced children, and preserves recently used state', async () => {
  const { retained } = setup(2)
  const a = new FakeChild(),
    b = new FakeChild(),
    c = new FakeChild()
  const ha = retained.retain('a', cast(a))
  await retained.release(cast(a))
  const hb = retained.retain('b', cast(b))
  await retained.release(cast(b))
  await retained.take(ha)
  await retained.release(cast(a))
  const hc = retained.retain('c', cast(c))
  await retained.release(cast(c))
  assert.equal(retained.size, 2)
  assert.equal(b.closes, 1)
  assert.equal(a.closes, 0)
  assert.equal(await retained.take(hb), undefined)
  assert.equal((await retained.take(ha))?.child, a)
  assert.equal((await retained.take(hc))?.child, c)
})

test('capacity does not terminate an active child and wakes evicted waiters', async () => {
  const { retained } = setup(1)
  const a = new FakeChild(),
    b = new FakeChild()
  const ha = retained.retain('a', cast(a))
  const waiting = retained.take(ha)
  retained.retain('b', cast(b))
  assert.equal(await waiting, undefined)
  assert.equal(a.closes, 0)
  await retained.release(cast(a))
  assert.equal(a.closes, 1)
})

test("evicting one of an idle child's states preserves its other state", async () => {
  const { retained } = setup(2)
  const a = new FakeChild(),
    b = new FakeChild()
  const old = retained.retain('old', cast(a))
  const current = retained.retain('current', cast(a))
  await retained.release(cast(a))
  retained.retain('other', cast(b))
  assert.equal(await retained.take(old), undefined)
  assert.equal(a.closes, 0)
  assert.equal((await retained.take(current))?.child, a)
})

for (const reason of ['exit', 'error', 'shutdown', 'abort'] as const)
  test(`waiting retries settle after ${reason}`, async () => {
    const { retained } = setup()
    const child = new FakeChild()
    const handle = retained.retain('state', cast(child))
    const controller = new AbortController()
    const waiting = retained.take(handle, controller.signal)
    if (reason === 'abort') controller.abort()
    else if (reason === 'shutdown') await retained.close()
    else {
      // Exercise the installed idle callbacks while a second handle is waiting.
      const released = retained.release(cast(child))
      if (reason === 'exit') child.onclose!()
      else child.onerror!(new Error('closed pipe'))
      await released
    }
    assert.equal(await waiting, undefined)
    if (reason === 'abort') {
      assert.equal(child.closes, 0)
      assert.equal((retained as any).flows.get(child).waiters.size, 0)
      assert.equal(await retained.take(handle, controller.signal), undefined)
    } else assert.equal(retained.size, 0)
  })

test('unknown handles do not create a backend', async () => {
  const { retained } = setup()
  assert.equal(await retained.take('sgw:missing'), undefined)
  assert.equal(retained.size, 0)
})

test('ordinary children close on release and late retention cannot survive shutdown', async () => {
  const { retained } = setup()
  const ordinary = new FakeChild()
  await retained.release(cast(ordinary))
  assert.equal(ordinary.closes, 1)
  await retained.close()
  const late = new FakeChild()
  const handle = retained.retain('late', cast(late))
  assert.equal(await retained.take(handle), undefined)
  await retained.release(cast(late))
  assert.equal(late.closes, 1)
  assert.equal(retained.size, 0)
})

test('shutdown awaits an earlier eviction and logs close failures', async () => {
  const { retained, errors } = setup(1)
  const a = new FakeChild(),
    b = new FakeChild()
  let finish!: () => void
  a.wait = new Promise((resolve) => {
    finish = resolve
  })
  a.fail = new Error('close failed')
  retained.retain('a', cast(a))
  await retained.release(cast(a))
  retained.retain('b', cast(b))
  let closed = false
  const shutdown = retained.close().then(() => {
    closed = true
  })
  await tick()
  assert.equal(closed, false)
  finish()
  await shutdown
  assert.equal(errors.length, 1)
  assert.equal(errors[0][1], a.fail)
  assert.equal((retained as any).closing.size, 0)
})

test('discard clears captured state and waiter collections before process shutdown completes', async () => {
  const { retained } = setup()
  const child = new FakeChild()
  let finish!: () => void
  child.wait = new Promise((resolve) => {
    finish = resolve
  })
  const handle = retained.retain('state', cast(child))
  const waiting = retained.take(handle)
  const flow = (retained as any).flows.get(child)
  assert.equal(flow.handles.size, 1)
  assert.equal(flow.waiters.size, 1)
  const closing = retained.discard(cast(child))
  assert.equal(retained.size, 0)
  assert.equal(flow.handles.size, 0)
  assert.equal(flow.waiters.size, 0)
  assert.equal((retained as any).flows.has(child), false)
  assert.equal(await waiting, undefined)
  finish()
  await closing
})

test('failure of one retained process leaves other continuations usable', async () => {
  const { retained } = setup()
  const a = new FakeChild(),
    b = new FakeChild()
  const ha = retained.retain('same', cast(a)),
    hb = retained.retain('same', cast(b))
  await retained.release(cast(a))
  await retained.release(cast(b))
  a.onerror!(new Error('only A failed'))
  assert.equal(await retained.take(ha), undefined)
  assert.deepEqual(await retained.take(hb, new AbortController().signal), {
    child: b,
    state: 'same',
  })
  assert.equal(b.closes, 0)
})

test('releasing an idle process refreshes rather than duplicates its timer', async (t) => {
  enableFakeTimers(t)
  const { retained } = setup()
  const child = new FakeChild()
  retained.retain('state', cast(child))
  await retained.release(cast(child))
  t.mock.timers.tick(300)
  await retained.release(cast(child))
  t.mock.timers.tick(499)
  assert.equal(child.closes, 0)
  t.mock.timers.tick(1)
  assert.equal(child.closes, 1)
})

for (const reason of ['release', 'abort'] as const)
  test(`a waiter removes its abort listener after ${reason}`, async () => {
    const { retained } = setup()
    const child = new FakeChild()
    const handle = retained.retain('state', cast(child))
    const controller = new AbortController()
    const waiting = retained.take(handle, controller.signal)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1)
    if (reason === 'abort') controller.abort()
    else await retained.release(cast(child))
    const result = await waiting
    assert.equal(result?.child, reason === 'abort' ? undefined : child)
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0)
  })

test('discard cancels the idle timer before its deadline', async (t) => {
  enableFakeTimers(t)
  const { retained } = setup()
  const child = new FakeChild()
  const handle = retained.retain('state', cast(child))
  await retained.release(cast(child))
  await retained.discard(cast(child))
  assert.equal(child.onclose, undefined)
  assert.equal(child.closes, 1)
  t.mock.timers.tick(1000)
  assert.equal(child.closes, 1, 'the discarded idle timer cannot close again')
  assert.equal(await retained.take(handle), undefined)
})
