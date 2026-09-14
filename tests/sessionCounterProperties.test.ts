import { test } from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { SessionAccessCounter } from '../src/lib/sessionAccessCounter.js'

// Property-based rather than example-based because this is one of the seven
// long-lived mutable bindings in the codebase — state declared in one scope and
// mutated by closures that run later. Order and multiplicity are the whole
// question here, and a single-pass example test cannot express that: every
// statement in this class already runs under the existing suite.
//
// Scope is deliberately narrow. Generated sequences are worth writing for a
// binding this heavily shared; they would be noise for one touched twice.

type Op =
  | { kind: 'inc'; session: string }
  | { kind: 'dec'; session: string }
  | { kind: 'clear'; session: string; runCleanup: boolean }

// A small alphabet of session ids, so sequences actually collide on the same
// session instead of each operation touching a fresh one. Collisions are where
// the interesting orderings live.
const session = fc.constantFrom('a', 'b', 'c')

const operation: fc.Arbitrary<Op> = fc.oneof(
  session.map((s) => ({ kind: 'inc' as const, session: s })),
  session.map((s) => ({ kind: 'dec' as const, session: s })),
  fc.tuple(session, fc.boolean()).map(([s, runCleanup]) => ({
    kind: 'clear' as const,
    session: s,
    runCleanup,
  })),
)

const run = (ops: Op[]) => {
  const cleaned: string[] = []
  const errors: string[] = []
  const counter = new SessionAccessCounter(
    60_000, // long enough that no idle timer fires during a sequence
    (id) => cleaned.push(id),
    { info: () => {}, error: (message) => errors.push(String(message)) },
  )
  for (const op of ops) {
    if (op.kind === 'inc') counter.inc(op.session, 'property')
    else if (op.kind === 'dec') counter.dec(op.session, 'property')
    else counter.clear(op.session, op.runCleanup, 'property')
  }
  return { cleaned, errors, counter }
}

test(
  'the session counter survives any ordering of its public operations',
  { timeout: 30000 },
  () => {
    // MCDC_E2E_FINDINGS DC-006 claims the `accessCount <= 0` throw at
    // sessionAccessCounter.ts:68 cannot be reached through ordinary public
    // operations, which is why coverage reports it as unreachable rather than
    // untested. That claim was reasoned about by hand; this challenges it with
    // several hundred generated orderings instead.
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 24 }), (ops) => {
        assert.doesNotThrow(
          () => run(ops),
          'no ordering of inc/dec/clear may reach the invalid-access-count throw',
        )
      }),
      { numRuns: 500 },
    )
  },
)

test(
  'clearing a session runs its cleanup exactly as often as it is asked to',
  { timeout: 30000 },
  () => {
    // The leak in GW-015 and #141 is about cleanup that never runs; the mirror
    // risk is cleanup that runs twice, which would tear down a session someone
    // else has since opened. Both are properties of a whole sequence, not of any
    // single call.
    fc.assert(
      fc.property(fc.array(operation, { maxLength: 24 }), (ops) => {
        const { cleaned } = run(ops)
        const requested = new Map<string, number>()
        const live = new Set<string>()
        for (const op of ops) {
          if (op.kind === 'inc') live.add(op.session)
          // `clear` drops the session whether or not cleanup was requested, and
          // does nothing at all for one that is not tracked. Modelling only the
          // cleanup-running case was wrong, and the property caught it on its
          // seventh generated sequence: [inc a, clear a false, clear a true].
          if (op.kind === 'clear' && live.has(op.session)) {
            if (op.runCleanup)
              requested.set(op.session, (requested.get(op.session) ?? 0) + 1)
            live.delete(op.session)
          }
        }
        const actual = new Map<string, number>()
        for (const id of cleaned) actual.set(id, (actual.get(id) ?? 0) + 1)
        assert.deepEqual(
          [...actual].sort(),
          [...requested].sort(),
          'cleanup runs once per explicit clear of a live session, and never otherwise',
        )
      }),
      { numRuns: 500 },
    )
  },
)
