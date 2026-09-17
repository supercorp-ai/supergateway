import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableFakeTimers } from './helpers/fake-timers.js'

test('continuation defaults keep 64 states for five idle minutes', async (t) => {
  // Load inside the test so initialization and its dependent behavior share
  // the same test lifetime, rather than executing in shared module setup.
  const { RetainedChildren, CONTINUATION_TIMEOUT, RETAINED_CHILD_LIMIT } =
    await import('../src/lib/retainedChildren.js')
  enableFakeTimers(t)
  const registry = new RetainedChildren({
    idleMs: CONTINUATION_TIMEOUT,
    limit: RETAINED_CHILD_LIMIT,
    logger: { info() {}, error() {} },
  })
  t.after(() => registry.close())
  const children = Array.from({ length: 65 }, () => ({
    closes: 0,
    async close() {
      this.closes++
    },
  }))
  const handles: string[] = []
  for (let i = 0; i < 64; i++) {
    handles.push(registry.retain('same', children[i] as any))
    await registry.release(children[i] as any)
  }
  assert.equal(
    children.reduce((sum, c) => sum + c.closes, 0),
    0,
  )
  const last = registry.retain('same', children[64] as any)
  await registry.release(children[64] as any)
  assert.equal(children[0].closes, 1, 'the 65th state evicts the oldest child')
  assert.equal(await registry.take(handles[0]), undefined)
  assert.equal(registry.size, 64)
  t.mock.timers.tick(299_999)
  assert.equal(children[64].closes, 0)
  t.mock.timers.tick(1)
  assert.equal(
    children[64].closes,
    1,
    'five idle minutes expires the retained child',
  )
  assert.equal(registry.size, 0)
  assert.equal(await registry.take(last), undefined)
})
