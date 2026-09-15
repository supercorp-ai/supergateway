import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertPositiveAccessCount } from '../src/lib/sessionAccessCounter.js'

/**
 * The guard `dec()` leans on, tested on its own terms.
 *
 * Inline in `dec()` this branch was unreachable: no ordering of inc/dec/clear
 * can produce a session held in the counting shape with a non-positive count,
 * which `sessionCounterProperties.test.ts` asserts over several hundred
 * generated orderings. That left a guard nothing could exercise — coverage
 * reported it forever untaken, and the only ways to change that were to delete
 * it or to manufacture a state the class cannot reach.
 *
 * As a function it has its own contract — "throws when handed a non-positive
 * count" — and that contract is ordinary to test. The guard survives, and the
 * obligation is discharged honestly rather than waived.
 */
test('a positive access count passes the invariant untouched', () => {
  assert.doesNotThrow(() => assertPositiveAccessCount(1, 'session-a'))
  assert.doesNotThrow(() => assertPositiveAccessCount(7, 'session-a'))
})

test('a non-positive access count is rejected, and names what it saw', () => {
  for (const count of [0, -1, -42]) {
    assert.throws(
      () => assertPositiveAccessCount(count, 'session-b'),
      (error: Error) => {
        // The message has to identify both the count and the session: a bare
        // throw here would tell whoever hits it nothing about which session
        // broke the invariant.
        assert.match(
          error.message,
          new RegExp(`Invalid access count ${count}\\b`),
        )
        assert.match(error.message, /session-b/)
        return true
      },
      `a count of ${count} must be rejected`,
    )
  }
})
