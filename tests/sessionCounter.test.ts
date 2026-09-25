import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionAccessCounter } from '../src/lib/sessionAccessCounter.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

test('session counter public API cancels pending cleanup and rejects duplicate release', async () => {
  const cleaned: string[] = []
  const errors: string[] = []
  const counter = new SessionAccessCounter(30, (id) => cleaned.push(id), {
    info() {},
    error: (message) => errors.push(String(message)),
  })
  counter.inc('pending', 'request opened')
  counter.dec('pending', 'request finished')
  counter.dec('pending', 'duplicate release')
  assert.match(errors[0], /already pending cleanup, ignoring/)
  counter.clear('pending', true, 'explicit cleanup')
  assert.deepEqual(cleaned, ['pending'])

  counter.inc('cancelled', 'request opened')
  counter.dec('cancelled', 'request finished')
  counter.clear('cancelled', false, 'owner already cleaned up')
  await delay(60)
  assert.deepEqual(
    cleaned,
    ['pending'],
    'cancelled timers must not clean up again',
  )
})

// GW-010: Node's setTimeout fires after 1 ms for any delay above 2^31-1 ms, so
// a --sessionTimeout of 30 days expired sessions almost at once. The counter
// now waits in hops; the session must survive every hop but the last, and a
// request arriving between hops must cancel the hop that is pending.
test('a session timeout beyond setTimeout’s range expires on time, not at once', (t) => {
  enableFakeTimers(t)
  const MAX = 2 ** 31 - 1
  const thirtyDays = 30 * 24 * 60 * 60 * 1000
  const cleaned: string[] = []
  const counter = new SessionAccessCounter(
    thirtyDays,
    (id) => cleaned.push(id),
    { info() {}, error() {} },
  )

  counter.inc('long', 'request opened')
  counter.dec('long', 'request finished')
  t.mock.timers.tick(MAX)
  assert.deepEqual(cleaned, [], 'still alive after the first hop')
  t.mock.timers.tick(thirtyDays - MAX - 1)
  assert.deepEqual(cleaned, [], 'still alive 1 ms before the deadline')
  t.mock.timers.tick(1)
  assert.deepEqual(cleaned, ['long'], 'cleaned up exactly at the deadline')

  counter.inc('revived', 'request opened')
  counter.dec('revived', 'request finished')
  t.mock.timers.tick(MAX + 1000)
  counter.inc('revived', 'a request between hops')
  t.mock.timers.tick(thirtyDays)
  assert.deepEqual(
    cleaned,
    ['long'],
    'a request during a later hop cancels the pending expiry',
  )
})
