import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableFakeTimers } from './helpers/fake-timers.js'
import { SessionLivenessProbe } from '../src/lib/sessionLivenessProbe.js'

// Two properties of the session liveness probe that the gateway's own tests
// cannot reach: its timers are clamped to at least five seconds there, and the
// gateway's HTTP server keeps the process alive regardless.
//
// - A stopped probe's idle grace is cancelled with it, so a GET that reopens
//   starts a full grace of its own instead of inheriting the old deadline.
// - No probe timer keeps the process alive: not the ping schedule, not the
//   idle grace and not the wait for a ping's reply.

const logger = { info() {}, error() {} }

const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

test('a reopened GET gets a whole idle grace, not the one its predecessor started', async (t) => {
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
  await settle()
  // The client answers, which proves it supports pings and restarts the grace:
  // it would now end at t=500.
  assert.equal(probe.accept({ jsonrpc: '2.0', id: sent[0], result: {} }), true)
  probe.stop()
  t.mock.timers.tick(200)
  // A new GET at t=300: its grace ends at t=700. Its first ping goes out at
  // t=400 and two misses follow by t=480, before either deadline.
  assert.equal(probe.start(), true)
  for (const at of [400, 440, 480]) {
    t.mock.timers.tick(at === 400 ? 100 : 40)
    await settle()
  }
  assert.equal(sent.length, 3)
  // Still inside the new grace: the probe waits a full interval and tries again
  // at t=580, which misses at t=620 — after the old deadline, before the new.
  t.mock.timers.tick(100)
  await settle()
  t.mock.timers.tick(40)
  await settle()
  // map: grace-cancelled-on-stop
  assert.equal(sent.length, 4)
  assert.equal(stale, 0, 'the grace of the stopped GET no longer counts')
  t.mock.timers.tick(100)
  await settle()
  t.mock.timers.tick(40)
  await settle()
  // map: new-grace-honoured
  assert.equal(stale, 1, 'past its own grace, the reopened GET is reaped')
  probe.close()
})

const refTimers = () =>
  process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length

test('a running liveness probe never keeps the process alive', async (t) => {
  // The test itself must outlive unref'd timers; this one is counted in the
  // baseline.
  const keepAlive = setInterval(() => {}, 1000)
  t.after(() => clearInterval(keepAlive))
  let pinged!: () => void
  const ping = new Promise<void>((resolve) => {
    pinged = resolve
  })
  const probe = new SessionLivenessProbe(
    20,
    60_000,
    60_000,
    async () => pinged(),
    () => {},
    logger,
  )
  // Closed even when an assertion fails, so a leaked timer cannot hold the
  // runner for its full delay.
  t.after(() => probe.close())
  const before = refTimers()
  probe.start()
  // map: schedule-and-grace-unref
  assert.equal(refTimers(), before, 'the ping schedule and the grace are unref')
  await ping
  await settle()
  // map: reply-wait-unref
  assert.equal(refTimers(), before, 'the wait for a ping reply is unref')
})
