/*
 * Unit tests for the client-disconnect crash fix in
 * src/gateways/stdioToStatelessStreamableHttp.ts (around line 191).
 *
 * The fix replaces a sync try/catch around `transport.send(jsonMsg)` with
 * `.catch()` on the returned promise. These tests prove that:
 *   - happy path: resolved send promise does not log an error
 *   - rejected send promise IS logged and does NOT crash the process
 *     (no unhandled-rejection event)
 *   - synchronous throws in send() are documented (the new pattern does
 *     NOT catch them — regression guard test below skips with a comment)
 *   - many rapid rejections are all caught + logged
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import {
  dispatchStreamableHttp,
  makeResolvingTransport,
  makeRejectingTransport,
  makeSyncThrowingTransport,
  makeSpyLogger,
  nextTick,
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

test('stateless streamable-http: resolved send logs no error', async () => {
  unhandled.length = 0
  const logger = makeSpyLogger()
  const transport = makeResolvingTransport()
  dispatchStreamableHttp(transport, { jsonrpc: '2.0', id: 1 }, logger)
  await nextTick()
  assert.equal(
    logger.errors.length,
    0,
    'no error should be logged on happy path',
  )
  assert.equal(unhandled.length, 0, 'no unhandled rejections')
})

test('stateless streamable-http: rejected send is caught and logged (THE FIX)', async () => {
  unhandled.length = 0
  const logger = makeSpyLogger()
  const transport = makeRejectingTransport(new Error('client disconnected'))
  // If the fix regressed, this line would throw / leave unhandled rejection.
  dispatchStreamableHttp(transport, { jsonrpc: '2.0', id: 1 }, logger)
  await nextTick()
  assert.equal(logger.errors.length, 1, 'exactly one error should be logged')
  assert.match(
    String(logger.errors[0].args[0]),
    /Failed to send to StreamableHttp/,
    'error message should match the live patched call site',
  )
  assert.equal(unhandled.length, 0, 'rejection must be CAUGHT, not unhandled')
})

test('stateless streamable-http: sync throw bubbles (documented regression — caller has outer try/catch)', async () => {
  /* The new `.catch()` only catches PROMISE rejections, not synchronous throws.
   * In the live gateway, an outer try/catch around the JSON.parse handles this
   * case. We document that here so a future contributor doesn't add a sync
   * throw to transport.send() expecting it to be caught by the .catch().
   */
  unhandled.length = 0
  const logger = makeSpyLogger()
  const transport = makeSyncThrowingTransport(new Error('sync boom'))
  assert.throws(
    () => dispatchStreamableHttp(transport, { jsonrpc: '2.0', id: 1 }, logger),
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

test('stateless streamable-http: 10 rapid rejections all caught, none unhandled', async () => {
  unhandled.length = 0
  const logger = makeSpyLogger()
  const transport = makeRejectingTransport(new Error('disconnected'))
  for (let i = 0; i < 10; i++) {
    dispatchStreamableHttp(transport, { jsonrpc: '2.0', id: i }, logger)
  }
  await nextTick()
  await nextTick()
  assert.equal(logger.errors.length, 10, 'all 10 rejections logged')
  assert.equal(unhandled.length, 0, 'no unhandled rejections under burst')
})
