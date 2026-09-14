import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionAccessCounter } from '../src/lib/sessionAccessCounter.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

test('session counter keeps active work alive, cancels idle cleanup and expires once', (t) => {
  enableFakeTimers(t)
  const cleaned: string[] = [],
    errors: string[] = []
  const counter = new SessionAccessCounter(30, (id) => cleaned.push(id), {
    info() {},
    error: (message) => errors.push(String(message)),
  })
  counter.inc('session', 'first request')
  counter.inc('session', 'second request')
  counter.dec('session', 'first completes')
  t.mock.timers.tick(60)
  assert.deepEqual(
    cleaned,
    [],
    'a remaining active request prevents idle expiry',
  )
  counter.dec('session', 'second completes')
  t.mock.timers.tick(29)
  assert.deepEqual(cleaned, [], 'cleanup waits for the full idle interval')
  counter.inc('session', 'reactivate before expiry')
  t.mock.timers.tick(60)
  assert.deepEqual(cleaned, [], 'reactivation cancels the pending timer')
  counter.dec('session', 'reactivated request completes')
  t.mock.timers.tick(30)
  assert.deepEqual(cleaned, ['session'])
  t.mock.timers.tick(60)
  assert.deepEqual(cleaned, ['session'], 'expiry fires once')
  counter.dec('session', 'late duplicate completion')
  assert.deepEqual(errors, [
    'Called dec() on non-existent session session, ignoring',
  ])
  counter.clear('absent', true, 'owner cleanup')
  assert.deepEqual(
    cleaned,
    ['session'],
    'clearing an absent session does not run cleanup',
  )
})
