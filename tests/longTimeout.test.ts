import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableFakeTimers } from './helpers/fake-timers.js'
import { MAX_TIMEOUT_MS, setLongTimeout } from '../src/lib/longTimeout.js'

// GW-010: Node treats a setTimeout delay above 2^31-1 ms as 1 ms, so a 30-day
// session timeout expired its session immediately. Delays past the limit are
// chained in maximal steps instead.
test('a delay past the setTimeout limit fires at the full delay, not at once', (t) => {
  enableFakeTimers(t)
  let fired = 0
  setLongTimeout(() => fired++, MAX_TIMEOUT_MS + 10).unref()
  t.mock.timers.tick(1)
  assert.equal(fired, 0, 'the overflowing delay is not treated as 1 ms')
  t.mock.timers.tick(MAX_TIMEOUT_MS - 1)
  assert.equal(fired, 0, 'the first step alone does not fire the callback')
  t.mock.timers.tick(9)
  assert.equal(fired, 0)
  t.mock.timers.tick(1)
  assert.equal(fired, 1, 'the callback runs once the whole delay has passed')
})

test('clearing a long timeout cancels whichever step is pending', (t) => {
  enableFakeTimers(t)
  let fired = 0
  const timer = setLongTimeout(() => fired++, MAX_TIMEOUT_MS * 2)
  t.mock.timers.tick(MAX_TIMEOUT_MS)
  timer.clear()
  t.mock.timers.tick(MAX_TIMEOUT_MS)
  assert.equal(fired, 0)
})

test('a delay within the limit is one ordinary timer', (t) => {
  enableFakeTimers(t)
  let fired = 0
  setLongTimeout(() => fired++, 25)
  t.mock.timers.tick(24)
  assert.equal(fired, 0)
  t.mock.timers.tick(1)
  assert.equal(fired, 1)
})
