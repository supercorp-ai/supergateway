import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { OwnedChildProcesses } from '../src/lib/ownedChildProcesses.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

const gone = () => Object.assign(new Error('gone'), { code: 'ESRCH' })
const child = (pid?: number) =>
  Object.assign(new EventEmitter(), {
    pid,
    kill: () => true,
  }) as unknown as ChildProcessWithoutNullStreams

test('owned group cleanup survives wrapper exit, waits for descendants and is idempotent', async (t) => {
  enableFakeTimers(t)
  const signals: unknown[] = [],
    errors: unknown[] = []
  let alive = true
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push([pid, signal])
    if (!alive) throw gone()
    return true
  })
  const owner = new OwnedChildProcesses({
    info() {},
    error: (...args) => errors.push(args),
  })
  assert.deepEqual(owner.spawnOptions, { shell: true, detached: true })
  const wrapper = child(2000004321)
  const stop = owner.own(wrapper)
  wrapper.emit('exit', 0, null)
  const pending = stop()
  assert.equal(
    stop(),
    pending,
    'one termination operation is shared by repeated callers',
  )
  assert.deepEqual(signals, [
    [-2000004321, 'SIGTERM'],
    [-2000004321, 0],
  ])
  let closed = false
  const closing = owner.close().then(() => {
    closed = true
  })
  await Promise.resolve()
  assert.equal(closed, false, 'wrapper exit does not finish group cleanup')
  alive = false
  t.mock.timers.tick(25)
  await closing
  assert.equal(closed, true)
  assert.deepEqual(signals, [
    [-2000004321, 'SIGTERM'],
    [-2000004321, 0],
    [-2000004321, 0],
  ])
  assert.deepEqual(errors, [])
  await owner.close()
  assert.equal(
    signals.length,
    3,
    'completed ownership is removed, without resending signals',
  )
})

test('owned group cleanup escalates after five seconds even when the wrapper already exited', async (t) => {
  enableFakeTimers(t)
  let now = 100
  t.mock.method(Date, 'now', () => now)
  const signals: unknown[] = []
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push([pid, signal])
    return true
  })
  const owner = new OwnedChildProcesses({ info() {}, error() {} })
  const wrapper = child(2000004322)
  const stop = owner.own(wrapper)
  wrapper.emit('exit', null, 'SIGTERM')
  now += 4999
  t.mock.timers.tick(25)
  await Promise.resolve()
  assert.equal(
    signals.some((x: any) => x[1] === 'SIGKILL'),
    false,
  )
  now += 1
  t.mock.timers.tick(25)
  await stop()
  assert.deepEqual(signals, [
    [-2000004322, 'SIGTERM'],
    [-2000004322, 0],
    [-2000004322, 0],
    [-2000004322, 0],
    [-2000004322, 'SIGKILL'],
  ])
  await owner.close()
})

test('failed spawns own no PID and already-gone groups need no escalation', async (t) => {
  const signals: unknown[] = [],
    errors: unknown[] = []
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push([pid, signal])
    throw gone()
  })
  const owner = new OwnedChildProcesses({
    info() {},
    error: (...args) => errors.push(args),
  })
  await owner.own(child())()
  assert.deepEqual(signals, [])
  await owner.own(child(2000004323))()
  assert.deepEqual(signals, [[-2000004323, 'SIGTERM']])
  assert.deepEqual(errors, [])
  await owner.close()
})

for (const stage of ['SIGTERM', 0, 'SIGKILL'] as const) {
  test(`owned group cleanup reports ${stage} errors without escaping`, async (t) => {
    enableFakeTimers(t)
    let now = 0
    t.mock.method(Date, 'now', () => now)
    const failure = Object.assign(new Error('denied'), { code: 'EPERM' })
    const errors: unknown[] = []
    t.mock.method(process, 'kill', (_pid, signal) => {
      if (signal === stage) throw failure
      return true
    })
    const owner = new OwnedChildProcesses({
      info() {},
      error: (...args) => errors.push(args),
    })
    const pending = owner.own(child(2000004324))()
    if (stage === 'SIGKILL') {
      now = 5000
      t.mock.timers.tick(25)
    }
    await pending
    assert.deepEqual(errors, [
      [`Failed to signal child 2000004324 with ${stage}:`, failure],
    ])
    await owner.close()
  })
}

for (const result of [false, true]) {
  test(`Windows uses only the direct-child signal fallback (kill result ${result})`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    t.after(() => Object.defineProperty(process, 'platform', platform))
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const signals: unknown[] = []
    t.mock.method(process, 'kill', () => {
      assert.fail('Windows must not receive a negative PID')
    })
    const wrapper = child(2000004325)
    t.mock.method(wrapper, 'kill', (signal) => {
      signals.push(signal)
      return signal === 'SIGTERM' && result
    })
    const owner = new OwnedChildProcesses({ info() {}, error() {} })
    assert.deepEqual(owner.spawnOptions, { shell: true, detached: false })
    const stop = owner.own(wrapper)
    Object.defineProperty(process, 'platform', platform)
    await stop()
    assert.deepEqual(signals, result ? ['SIGTERM', 0] : ['SIGTERM'])
    await owner.close()
  })
}

test('shutdown drains a child acquired by setup that was already in flight', async (t) => {
  enableFakeTimers(t)
  const signals: unknown[] = []
  let firstAlive = true
  t.mock.method(process, 'kill', (pid, signal) => {
    signals.push([pid, signal])
    if (pid !== -2000000001 || !firstAlive) throw gone()
    return true
  })
  const owner = new OwnedChildProcesses({ info() {}, error() {} })
  owner.own(child(2000000001))
  const closing = owner.close()
  assert.equal(owner.closing, true)
  owner.own(child(2000000002))
  firstAlive = false
  t.mock.timers.tick(25)
  await closing
  assert.deepEqual(signals, [
    [-2000000001, 'SIGTERM'],
    [-2000000001, 0],
    [-2000000001, 0],
    [-2000000002, 'SIGTERM'],
  ])
})
