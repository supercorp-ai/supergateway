import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { SessionAccessCounter } from '../src/lib/sessionAccessCounter.js'

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
