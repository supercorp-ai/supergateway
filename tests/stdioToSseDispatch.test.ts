/*
 * Unit tests for the client-disconnect crash fix in
 * src/gateways/stdioToSse.ts (around line 182).
 *
 * SSE fans out the message to every open session. The fix replaces a sync
 * try/catch around `session.transport.send(jsonMsg)` with `.catch()` on the
 * returned promise AND deletes the failing session from the sessions map.
 *
 * These tests prove that:
 *   - happy path: resolved sends log no errors, sessions are preserved
 *   - rejected sends are caught + logged + the broken session is deleted
 *   - mixed fanout (one good, one bad) preserves the good and drops the bad
 *   - many rapid disconnects all logged + all sessions deleted, no crash
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchSse,
  makeResolvingTransport,
  makeRejectingTransport,
  makeSyncThrowingTransport,
  makeSpyLogger,
  nextTick,
  type MinimalSession,
} from './helpers/dispatch-helpers.js'

const unhandled: unknown[] = []
const onUnhandled = (reason: unknown) => {
  unhandled.push(reason)
}

before(() => {
  process.on('unhandledRejection', onUnhandled)
})

after(() => {
  process.off('unhandledRejection', onUnhandled)
})

test('sse: resolved sends log no error, sessions preserved', async () => {
  unhandled.length = 0
  const logger = makeSpyLogger()
  const sessions: Record<string, MinimalSession> = {
    a: { transport: makeResolvingTransport() },
    b: { transport: makeResolvingTransport() },
  }
  dispatchSse(sessions, { jsonrpc: '2.0', id: 1 }, logger)
  await nextTick()
  assert.equal(logger.errors.length, 0, 'no error on happy path')
  assert.deepEqual(
    Object.keys(sessions).sort(),
    ['a', 'b'],
    'all sessions preserved',
  )
  assert.equal(unhandled.length, 0, 'no unhandled rejections')
})

test('sse: rejected send is caught, logged, and session is dropped (THE FIX)', async () => {
  unhandled.length = 0
  const logger = makeSpyLogger()
  const sessions: Record<string, MinimalSession> = {
    'dead-session': {
      transport: makeRejectingTransport(new Error('client gone')),
    },
  }
  dispatchSse(sessions, { jsonrpc: '2.0', id: 1 }, logger)
  await nextTick()
  assert.equal(logger.errors.length, 1, 'exactly one error logged')
  assert.match(
    String(logger.errors[0].args[0]),
    /Failed to send to session dead-session/,
    'error message includes the failing session id (matches live patched call site)',
  )
  assert.equal(
    Object.keys(sessions).length,
    0,
    'broken session removed from sessions map',
  )
  assert.equal(unhandled.length, 0, 'rejection must be CAUGHT, not unhandled')
})

test('sse: mixed fanout — good session preserved, bad session dropped', async () => {
  unhandled.length = 0
  const logger = makeSpyLogger()
  const sessions: Record<string, MinimalSession> = {
    good: { transport: makeResolvingTransport() },
    bad: { transport: makeRejectingTransport(new Error('disconnected')) },
  }
  dispatchSse(sessions, { jsonrpc: '2.0', id: 1 }, logger)
  await nextTick()
  assert.equal(logger.errors.length, 1, 'one error for the bad session')
  assert.deepEqual(Object.keys(sessions), ['good'], 'only good session remains')
  assert.equal(unhandled.length, 0, 'no unhandled rejections')
})

test('sse: sync throw bubbles (documented — outer try/catch handles)', async () => {
  /* As with the streamable-http gateways, the new `.catch()` only catches
   * PROMISE rejections, not synchronous throws. The live SSE gateway has
   * an outer try/catch around the JSON.parse that catches sync throws.
   * Documenting here so a future contributor understands the boundary.
   */
  unhandled.length = 0
  const logger = makeSpyLogger()
  const sessions: Record<string, MinimalSession> = {
    sync: { transport: makeSyncThrowingTransport(new Error('sync boom')) },
  }
  assert.throws(
    () => dispatchSse(sessions, { jsonrpc: '2.0', id: 1 }, logger),
    /sync boom/,
    'sync throws are NOT caught by .catch() — must be handled by outer try/catch in caller',
  )
  await nextTick()
  assert.equal(
    unhandled.length,
    0,
    'no unhandled rejections (sync throw, not async)',
  )
})

test('sse: 10 rapid disconnects all logged, all sessions dropped, none unhandled', async () => {
  unhandled.length = 0
  const logger = makeSpyLogger()
  const sessions: Record<string, MinimalSession> = {}
  for (let i = 0; i < 10; i++) {
    sessions[`s${i}`] = {
      transport: makeRejectingTransport(new Error('disconnect ' + i)),
    }
  }
  dispatchSse(sessions, { jsonrpc: '2.0', id: 1 }, logger)
  await nextTick()
  await nextTick()
  assert.equal(logger.errors.length, 10, 'all 10 rejections logged')
  assert.equal(Object.keys(sessions).length, 0, 'all broken sessions removed')
  assert.equal(unhandled.length, 0, 'no unhandled rejections under burst')
})
