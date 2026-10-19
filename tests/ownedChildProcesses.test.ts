import { test, beforeEach, afterEach } from 'node:test'
import childProcess from 'node:child_process'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcessWithoutNullStreams } from 'child_process'
import { OwnedChildProcesses } from '../src/lib/ownedChildProcesses.js'
import { enableFakeTimers } from './helpers/fake-timers.js'

const nativePlatform = Object.getOwnPropertyDescriptor(process, 'platform')!
beforeEach(() =>
  Object.defineProperty(process, 'platform', {
    ...nativePlatform,
    value: 'linux',
  }),
)
afterEach(() => Object.defineProperty(process, 'platform', nativePlatform))

const gone = () => Object.assign(new Error('gone'), { code: 'ESRCH' })
const child = (pid?: number) =>
  Object.assign(new EventEmitter(), {
    pid,
    // Running, as a real ChildProcess reports it until it exits.
    exitCode: null,
    signalCode: null,
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
    const failure = Object.assign(new Error('invalid'), { code: 'EINVAL' })
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

// macOS answers EPERM, not ESRCH, for a group whose processes have all exited
// but are not reaped yet: the moment after a child is stopped, or after it
// exits by itself.
const refused = () => Object.assign(new Error('denied'), { code: 'EPERM' })

for (const from of ['SIGTERM', 0] as const) {
  test(`a group not reaped yet, refusing from ${from}, is waited for and not reported`, async (t) => {
    enableFakeTimers(t)
    let now = 0
    t.mock.method(Date, 'now', () => now)
    const signals: unknown[] = [],
      errors: unknown[] = []
    let reaped = false
    t.mock.method(process, 'kill', (pid, signal) => {
      signals.push([pid, signal])
      if (reaped) throw gone()
      if (signal === 'SIGTERM' && from === 0) return true
      throw refused()
    })
    const owner = new OwnedChildProcesses({
      info() {},
      error: (...args) => errors.push(args),
    })
    let stopped = false
    const pending = owner
      .own(child(2000004326))()
      .then(() => {
        stopped = true
      })
    await Promise.resolve()
    assert.equal(stopped, false, 'a refusal is not the group being gone')
    now = 25
    reaped = true
    t.mock.timers.tick(25)
    await pending
    assert.deepEqual(signals, [
      [-2000004326, 'SIGTERM'],
      [-2000004326, 0],
      [-2000004326, 0],
    ])
    assert.deepEqual(errors, [])
    await owner.close()
  })
}

test('a group that keeps refusing is reported once, after a second', async (t) => {
  enableFakeTimers(t)
  let now = 0
  t.mock.method(Date, 'now', () => now)
  const failure = refused()
  const signals: unknown[] = [],
    errors: unknown[] = []
  t.mock.method(process, 'kill', (_pid, signal) => {
    signals.push(signal)
    throw failure
  })
  const owner = new OwnedChildProcesses({
    info() {},
    error: (...args) => errors.push(args),
  })
  const pending = owner.own(child(2000004327))()
  now = 999
  t.mock.timers.tick(25)
  await Promise.resolve()
  assert.deepEqual(errors, [], 'within the second it may only be unreaped')
  now = 1000
  t.mock.timers.tick(25)
  await Promise.resolve()
  assert.deepEqual(errors, [
    ['Failed to signal child 2000004327 with 0:', failure],
  ])
  await pending
  assert.deepEqual(signals, ['SIGTERM', 0, 0, 0], 'and is not signalled again')
  await owner.close()
})

// taskkill reports each process it ends; the gateway logs them, and names any
// whose parent is outside the server's tree (a freed process ID taken by
// another process between taskkill listing the tree and ending it).
const SUCCESS = (pid: number, parent: number) =>
  `SUCCESS: The process with PID ${pid} (child process of PID ${parent}) has been terminated.\r\n`
for (const [label, stdout, expected] of [
  [
    'its own tree',
    SUCCESS(8000, 2000004330) + SUCCESS(2000004330, 900),
    {
      info: ['Ended server tree 2000004330: 8000<2000004330 2000004330<900'],
      errors: [],
    },
  ],
  [
    'a process outside it',
    SUCCESS(8000, 2000004330) + SUCCESS(8100, 7777) + SUCCESS(2000004330, 900),
    {
      info: [
        'Ended server tree 2000004330: 8000<2000004330 8100<7777 2000004330<900',
      ],
      errors: [
        'Ending server tree 2000004330 also ended process 8100, whose parent 7777 is outside it',
      ],
    },
  ],
  ['nothing it could report', '', { info: [], errors: [] }],
] as const) {
  test(`Windows logs what taskkill ended: ${label}`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    t.after(() => Object.defineProperty(process, 'platform', platform))
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const info: string[] = []
    const errors: string[] = []
    t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
      ;(args.at(-1) as (error: null, stdout: string) => void)(null, stdout)
    }) as unknown as typeof childProcess.execFile)
    const owner = new OwnedChildProcesses({
      info: (message: string) => info.push(message),
      error: (message: string) => errors.push(message),
    })
    const stop = owner.own(child(2000004330))
    Object.defineProperty(process, 'platform', platform)
    await stop()
    assert.deepEqual({ info, errors }, expected)
  })
}

for (const result of [undefined, 128, 5]) {
  test(`Windows terminates the owned process tree (taskkill result ${result})`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    t.after(() => Object.defineProperty(process, 'platform', platform))
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const calls: unknown[] = [],
      errors: unknown[] = []
    t.mock.method(process, 'kill', () => {
      assert.fail('Windows must not receive a negative PID')
    })
    const wrapper = child(2000004325)
    t.mock.method(wrapper, 'kill', () => {
      assert.fail('Do not kill the shell before terminating its tree')
    })
    t.mock.method(childProcess, 'execFile', ((
      file: string,
      args: string[],
      options: unknown,
      callback: (error?: Error) => void,
    ) => {
      calls.push([file, args, options])
      callback(
        result === undefined
          ? undefined
          : Object.assign(new Error('taskkill'), { code: result }),
      )
    }) as typeof childProcess.execFile)
    const owner = new OwnedChildProcesses({
      info() {},
      error: (...args) => errors.push(args),
    })
    assert.deepEqual(owner.spawnOptions, { shell: true, detached: false })
    const stop = owner.own(wrapper)
    Object.defineProperty(process, 'platform', platform)
    await stop()
    // A failure is retried while the shell still runs, as this one does
    // throughout: three attempts, each reported, then that the tree may
    // still be running.
    const attempts = result === 5 ? 3 : 1
    assert.deepEqual(
      calls,
      Array(attempts).fill([
        'taskkill.exe',
        ['/PID', '2000004325', '/T', '/F'],
        { windowsHide: true, timeout: 15000 },
      ]),
    )
    assert.equal(errors.length, result === 5 ? 4 : 0)
    if (result === 5)
      assert.deepEqual(errors.at(-1), [
        'Could not end server tree 2000004325 in 3 attempts; it may still be running',
      ])
    await owner.close()
    assert.equal(calls.length, attempts, 'cleanup remains idempotent')
  })
}

// The 4.2.1-rc.2 soak's leak: taskkill killed at its budget on a stalled
// host, and the servers it was ending left running for hours.
const timedOut = () =>
  Object.assign(new Error('Command failed: taskkill.exe'), {
    code: null,
    killed: true,
    signal: 'SIGTERM',
  })
for (const then of ['ends the tree', 'finds the shell gone'] as const) {
  test(`Windows retries a taskkill that timed out, and the retry ${then}`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    t.after(() => Object.defineProperty(process, 'platform', platform))
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const wrapper = child(2000004326)
    const errors: unknown[] = []
    let calls = 0
    t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
      const callback = args.at(-1) as (
        error: Error | null,
        stdout: string,
      ) => void
      if (++calls === 1) {
        // The shell exits while the gateway waits to try again.
        if (then === 'finds the shell gone')
          setTimeout(() => Object.assign(wrapper, { exitCode: 1 }), 50)
        return callback(timedOut(), '')
      }
      callback(null, SUCCESS(2000004326, 900))
    }) as unknown as typeof childProcess.execFile)
    const owner = new OwnedChildProcesses({
      info() {},
      error: (...args) => errors.push(args),
    })
    const stop = owner.own(wrapper)
    Object.defineProperty(process, 'platform', platform)
    await stop()
    assert.equal(calls, then === 'ends the tree' ? 2 : 1)
    assert.equal(errors.length, 1, 'the timed-out attempt is reported')
    assert.match(
      String((errors[0] as unknown[])[0]),
      /Failed to terminate child tree 2000004326/,
    )
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

for (const ending of ['exited', 'was killed', 'never started'] as const) {
  test(`Windows ends no tree for a shell that ${ending === 'never started' ? 'never started: it has no PID' : `${ending}: its PID may be another process's now`}`, async (t) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    t.after(() => Object.defineProperty(process, 'platform', platform))
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const calls: unknown[] = []
    t.mock.method(childProcess, 'execFile', ((...args: unknown[]) => {
      calls.push(args.slice(0, 2))
      ;(args.at(-1) as () => void)()
    }) as unknown as typeof childProcess.execFile)
    const owner = new OwnedChildProcesses({ info() {}, error() {} })
    const wrapper = child(ending === 'never started' ? undefined : 2000004326)
    owner.own(wrapper)
    Object.defineProperty(process, 'platform', platform)
    // The shell exits by itself, or is ended by a signal, and that stops it.
    if (ending === 'exited') Object.assign(wrapper, { exitCode: 0 })
    if (ending === 'was killed')
      Object.assign(wrapper, { signalCode: 'SIGTERM' })
    if (ending !== 'never started')
      wrapper.emit('exit', wrapper.exitCode, wrapper.signalCode)
    await owner.close()
    assert.deepEqual(calls, [])
  })
}
