import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableFakeTimers } from './helpers/fake-timers.js'
import { ReconnectSchedule } from '../src/gateways/reconnectSchedule.js'

// When a bridge that lost its upstream tries again. One reconnect is pending
// at a time, and once it has run, or been dropped, the next can be scheduled.

test('a reconnect that ran leaves room for the next', (t) => {
  enableFakeTimers(t)
  const schedule = new ReconnectSchedule()
  const ran: string[] = []
  schedule.schedule(() => ran.push('first'))
  // One at a time: this one is not added to it.
  schedule.schedule(() => ran.push('ignored'))
  t.mock.timers.tick(1000)
  assert.deepEqual(ran, ['first'])
  schedule.schedule(() => ran.push('second'))
  t.mock.timers.tick(1000)
  assert.deepEqual(ran, ['first', 'second'])
})

test('a reconnect that was dropped does not run, and leaves room for the next', (t) => {
  enableFakeTimers(t)
  const schedule = new ReconnectSchedule()
  const ran: string[] = []
  schedule.schedule(() => ran.push('dropped'))
  schedule.cancel()
  // Dropping nothing is nothing.
  schedule.cancel()
  schedule.schedule(() => ran.push('next'))
  t.mock.timers.tick(1000)
  assert.deepEqual(ran, ['next'])
})

test('each failure doubles the wait, up to half a minute, and a success starts over', (t) => {
  enableFakeTimers(t)
  const schedule = new ReconnectSchedule()
  let ran = 0
  const after = (ms: number) => {
    schedule.schedule(() => ran++)
    t.mock.timers.tick(ms - 1)
    const early = ran
    t.mock.timers.tick(1)
    return [early, ran]
  }
  assert.deepEqual(after(1000), [0, 1])
  schedule.backOff()
  assert.deepEqual(after(2000), [1, 2])
  for (let i = 0; i < 10; i++) schedule.backOff()
  assert.deepEqual(after(30_000), [2, 3])
  schedule.reset()
  assert.deepEqual(after(1000), [3, 4])
})
