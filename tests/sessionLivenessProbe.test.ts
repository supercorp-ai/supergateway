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
