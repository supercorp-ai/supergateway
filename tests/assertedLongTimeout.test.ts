import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_TIMEOUT_MS, setLongTimeout } from '../src/lib/longTimeout.js'

// setLongTimeout's unref(), as setTimeout's own: the timer stops holding the
// process open at once, and the call returns the timer so it can be chained.
// The session liveness probe's grace timer relies on the first.

// Timers that hold the event loop open. An unref'd timer is not counted.
const heldTimers = () =>
  process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length

test('an unref’d long timeout stops holding the process at once, and is returned for chaining', (t) => {
  const before = heldTimers()
  const pending = setLongTimeout(() => {}, MAX_TIMEOUT_MS + 10)
  // A failed assertion must not leave it holding the test process open.
  t.after(() => pending.clear())
  assert.equal(heldTimers(), before + 1)
  const unrefed = pending.unref()
  // map: unref() releases the step that is pending now, not only later ones
  assert.equal(heldTimers(), before)
  // map: unref() returns the timer itself
  assert.equal(unrefed, pending)
})
