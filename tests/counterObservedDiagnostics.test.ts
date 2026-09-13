import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SessionAccessCounter } from '../src/lib/sessionAccessCounter.js'

test('session counter diagnostics identify transitions, duplicate releases and expiration', (t) => {
  const info: string[] = [],
    errors: string[] = [],
    cleaned: string[] = []
  const counter = new SessionAccessCounter(50, (id) => cleaned.push(id), {
    info: (message) => info.push(String(message)),
    error: (message) => errors.push(String(message)),
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  counter.dec('missing', 'probe')
  counter.inc('s1', 'first')
  counter.inc('s1', 'second')
  counter.dec('s1', 'first finished')
  counter.dec('s1', 'second finished')
  counter.dec('s1', 'duplicate')
  counter.inc('s1', 'resume')
  counter.dec('s1', 'resumed finished')
  t.mock.timers.tick(50)
  counter.clear('s1', false, 'after expiration')
  // map: transition-diagnostics
  assert.deepEqual(info, [
    'SessionAccessCounter.dec() missing, caused by probe',
    'SessionAccessCounter.inc() s1, caused by first',
    'Session access count 0 -> 1 for s1 (new session)',
    'SessionAccessCounter.inc() s1, caused by second',
    'Session access count 1 -> 2 for s1',
    'SessionAccessCounter.dec() s1, caused by first finished',
    'Session access count 2 -> 1 for s1',
    'SessionAccessCounter.dec() s1, caused by second finished',
    'Session access count 1 -> 0 for s1',
    'Session access count reached 0, setting cleanup timeout for s1',
    'SessionAccessCounter.dec() s1, caused by duplicate',
    'SessionAccessCounter.inc() s1, caused by resume',
    'Session access count 0 -> 1, clearing cleanup timeout for s1',
    'SessionAccessCounter.dec() s1, caused by resumed finished',
    'Session access count 1 -> 0 for s1',
    'Session access count reached 0, setting cleanup timeout for s1',
    'Session s1 timed out, cleaning up',
    'SessionAccessCounter.clear() s1, caused by after expiration',
    'Attempted to clear non-existent session s1',
  ])
  // map: ignored-releases
  assert.deepEqual(errors, [
    'Called dec() on non-existent session missing, ignoring',
    'Called dec() on session s1 that is already pending cleanup, ignoring',
  ])
  // map: single-cleanup
  assert.deepEqual(cleaned, ['s1'])
})
