import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableFakeTimers } from './helpers/fake-timers.js'
import { SessionLivenessProbe } from '../src/lib/sessionLivenessProbe.js'

const logger = { info() {}, error() {} }

test('ping replies and ordinary requests keep an open session alive', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  let stale = 0
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    async (id) => {
      sent.push(id)
    },
    () => stale++,
    logger,
  )
  assert.equal(probe.start(), true)
  assert.equal(probe.start(), false, 'a second GET cannot own the same probe')
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(sent.length, 1)
  assert.equal(probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} }), true)
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(sent.length, 2)
  probe.activity()
  t.mock.timers.tick(40)
  assert.equal(stale, 0, 'client activity forgives an unanswered ping')
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(sent.length, 3)
  assert.equal(
    probe.accept({
      jsonrpc: '2.0',
      id: sent[2],
      error: { code: -32601, message: 'Method not found' },
    }),
    true,
    'even a protocol error proves that the client is present',
  )
  t.mock.timers.tick(39)
  assert.equal(stale, 0)
  probe.stop()
  t.mock.timers.tick(1000)
  assert.equal(sent.length, 3)
  assert.equal(probe.start(), true, 'a replacement GET may restart probing')
  probe.close()
  assert.equal(probe.start(), false)
})

test('two unanswered pings close a previously responsive client behind a proxy', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  let stale = 0
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    async (id) => {
      sent.push(id)
    },
    () => stale++,
    logger,
  )
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(sent.length, 1)
  probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} })
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(sent.length, 2)
  t.mock.timers.tick(40)
  await Promise.resolve()
  assert.equal(sent.length, 3)
  assert.equal(stale, 0)
  t.mock.timers.tick(40)
  assert.equal(stale, 1)
  t.mock.timers.tick(1000)
  assert.equal(stale, 1)
  assert.equal(sent.length, 3)
})

test('a client that never answers pings keeps its session for compatibility', async (t) => {
  enableFakeTimers(t)
  let stale = 0
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    async () => {},
    () => stale++,
    logger,
  )
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  t.mock.timers.tick(40)
  await Promise.resolve()
  t.mock.timers.tick(40)
  assert.equal(stale, 0)
})

test('missed pings do not shorten the configured idle grace period', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  let stale = 0
  const probe = new SessionLivenessProbe(
    100,
    40,
    400,
    async (id) => {
      sent.push(id)
    },
    () => stale++,
    logger,
  )
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} })
  t.mock.timers.tick(100)
  await Promise.resolve()
  t.mock.timers.tick(40)
  await Promise.resolve()
  t.mock.timers.tick(40)
  assert.equal(stale, 0)
  t.mock.timers.tick(100)
  await Promise.resolve()
  t.mock.timers.tick(40)
  assert.equal(stale, 0)
  t.mock.timers.tick(100)
  await Promise.resolve()
  t.mock.timers.tick(40)
  assert.equal(stale, 1)
})

// GW-010 for the probe: the idle grace is --sessionTimeout itself, and a grace
// above setTimeout's 2^31-1 ms used to fire after 1 ms, so a 30-day session
// became reapable after its first two missed pings.
test('an idle grace beyond setTimeout’s range is not cut to 1 ms', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  let stale = 0
  const probe = new SessionLivenessProbe(
    100,
    40,
    30 * 24 * 60 * 60 * 1000,
    async (id) => {
      sent.push(id)
    },
    () => stale++,
    logger,
  )
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} })
  for (let cycle = 0; cycle < 3; cycle++) {
    t.mock.timers.tick(100)
    await Promise.resolve()
    t.mock.timers.tick(40)
    await Promise.resolve()
    t.mock.timers.tick(40)
  }
  assert.equal(stale, 0, 'missed pings inside the 30-day grace do not reap')
  probe.stop()
})

test('late ping responses are consumed instead of leaking to the MCP child', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    async (id) => {
      sent.push(id)
    },
    () => {},
    logger,
  )
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  probe.activity()
  assert.equal(probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} }), true)
  assert.equal(
    probe.accept({ jsonrpc: '2.0', id: 'ordinary-tool-id', result: {} }),
    false,
  )
})

test('a long-running POST suppresses liveness probes until its response ends', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  let stale = 0
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    async (id) => {
      sent.push(id)
    },
    () => stale++,
    logger,
  )
  probe.start()
  probe.requestStarted()
  t.mock.timers.tick(1000)
  assert.equal(sent.length, 0)
  assert.equal(stale, 0)
  probe.requestFinished()
  t.mock.timers.tick(100)
  assert.equal(sent.length, 1)
})

test('a POST already in flight when GET starts delays the first probe', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  const probe = new SessionLivenessProbe(
    300_000,
    40,
    100,
    async (id) => {
      sent.push(id)
    },
    () => {},
    logger,
  )
  probe.requestStarted()
  probe.start()
  t.mock.timers.tick(5_000)
  assert.deepEqual(sent, [])
  probe.requestFinished()
  probe.requestFinished() // A duplicate completion cannot underflow the count.
  t.mock.timers.tick(4_999)
  assert.equal(sent.length, 0)
  t.mock.timers.tick(1)
  assert.equal(sent.length, 1)
})

test('a long default interval still establishes ping support shortly after GET opens', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  const probe = new SessionLivenessProbe(
    300_000,
    30_000,
    1_800_000,
    async (id) => {
      sent.push(id)
    },
    () => {},
    logger,
  )
  probe.start()
  t.mock.timers.tick(4_999)
  assert.equal(sent.length, 0)
  t.mock.timers.tick(1)
  await Promise.resolve()
  assert.equal(sent.length, 1)
  probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} })
  t.mock.timers.tick(299_999)
  assert.equal(
    sent.length,
    1,
    'later pings retain the bounded regular interval',
  )
  t.mock.timers.tick(1)
  assert.equal(sent.length, 2)
})

test('a ping reply remains proof of support across GET reconnects', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  let stale = 0
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    async (id) => {
      sent.push(id)
    },
    () => stale++,
    logger,
  )
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} })
  probe.stop()
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(sent.length, 2)
  t.mock.timers.tick(40)
  await Promise.resolve()
  assert.equal(sent.length, 3)
  t.mock.timers.tick(40)
  assert.equal(stale, 1, 'a vanished client is reaped without a new pong')
})

test('only replies to gateway pings count as proof of life', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    async (id) => {
      sent.push(id)
    },
    () => {},
    logger,
  )
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(
    probe.accept({ jsonrpc: '2.0', method: 'notifications/test' } as any),
    false,
  )
  assert.equal(
    probe.accept({ jsonrpc: '2.0', id: sent[0], method: 'ping' } as any),
    false,
  )
  assert.equal(probe.accept({ jsonrpc: '2.0', id: 1, result: {} }), false)
  assert.equal(probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} }), true)
})

test('send failure counts as a miss, while failures after stop or activity are ignored', async (t) => {
  enableFakeTimers(t)
  const errors: unknown[] = []
  let rejectSend: ((error: Error) => void) | undefined
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectSend = reject
      }),
    () => {},
    { info() {}, error: (_message, error) => errors.push(error) },
  )
  const settle = async () => {
    for (let i = 0; i < 4; i++) await Promise.resolve()
  }
  probe.start()
  t.mock.timers.tick(100)
  rejectSend!(new Error('network write failed'))
  await settle()
  assert.equal(errors.length, 1)
  // The failed first send immediately starts a second probe.
  rejectSend!(new Error('late after activity'))
  probe.activity()
  await settle()
  assert.equal(errors.length, 1)
  t.mock.timers.tick(100)
  rejectSend!(new Error('late after stop'))
  probe.stop()
  await settle()
  assert.equal(errors.length, 1)
})

test('late timer and send completions cannot revive an obsolete probe', async (t) => {
  const timers: Array<() => void> = []
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void) => {
    timers.push(callback)
    return { unref() {} } as NodeJS.Timeout
  }) as typeof setTimeout)
  t.mock.method(globalThis, 'clearTimeout', (() => {}) as typeof clearTimeout)
  let resolveSend: (() => void) | undefined
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    () =>
      new Promise<void>((resolve) => {
        resolveSend = resolve
      }),
    () => {},
    logger,
  )
  probe.start()
  const originalSchedule = timers[1]
  probe.stop()
  originalSchedule()
  assert.equal(resolveSend, undefined, 'stopped timer does not send')
  probe.start()
  const replacedSchedule = timers.at(-1)!
  probe.activity()
  replacedSchedule()
  assert.equal(resolveSend, undefined, 'obsolete revision does not send')
  timers.at(-1)!() // Current schedule sends.
  assert.ok(resolveSend)
  probe.activity()
  resolveSend!()
  await Promise.resolve()
  assert.equal(timers.length, 8, 'late success does not arm a reply timeout')

  timers.at(-1)!()
  probe.stop()
  resolveSend!()
  await Promise.resolve()
  assert.equal(timers.length, 8, 'a stopped probe ignores a late send')

  probe.start()
  timers.at(-1)!()
  resolveSend!()
  await Promise.resolve()
  const obsoleteReplyTimer = timers.at(-1)!
  probe.activity()
  obsoleteReplyTimer()
  assert.equal(
    timers.length,
    13,
    'a superseded reply timer cannot count a miss',
  )
  probe.stop()
  obsoleteReplyTimer()
})

test('a replacement GET does not inherit the previous stream’s missed pings', async (t) => {
  enableFakeTimers(t)
  const sent: string[] = []
  let stale = 0
  const probe = new SessionLivenessProbe(
    100,
    40,
    100,
    async (id) => {
      sent.push(id)
    },
    () => stale++,
    logger,
  )
  probe.start()
  t.mock.timers.tick(100)
  await Promise.resolve()
  probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} })
  t.mock.timers.tick(100)
  await Promise.resolve()
  t.mock.timers.tick(40)
  await Promise.resolve()
  assert.equal(sent.length, 3, 'one ping went unanswered on the first stream')
  probe.stop()
  assert.equal(probe.start(), true)
  t.mock.timers.tick(100)
  await Promise.resolve()
  assert.equal(sent.length, 4)
  t.mock.timers.tick(40)
  await Promise.resolve()
  assert.equal(stale, 0, 'a single miss on the new stream is not two')
  assert.equal(sent.length, 5, 'the new stream retries after its first miss')
})
