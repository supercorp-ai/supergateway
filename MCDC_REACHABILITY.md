# MC/DC reachability audit

2026-09-05. Production sources are unchanged from the PR base. The passing
suite covers 104/129 conditions (80.62%); 25 remain. This inventory counts
individual conditions, not decisions or lines. No exclusions or adjusted
denominators are used.

## Four conditions reached in the earlier startup audit

| Condition                                             | Real boundary and assertion                                                                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| SSE wrapper: `requestMessage.method === 'initialize'` | Pipelined CLI stdin requests; handshake and tool replies retain their own IDs/payloads and a subsequent tool request succeeds.        |
| HTTP wrapper: initialize-schema `.success`            | Same CLI startup case through real HTTP. The temporary wrapper can receive non-initialize requests while connection setup is pending. |
| Stateless initialization: `'id' in msg`               | HTTP notification shaped like initialize but without an ID; no JSON-RPC reply is invented, and an independent later request succeeds. |
| WebSocket cleanup: `child`                            | Exported gateway API with an empty child-command configuration; startup fails with exit 1 rather than crashing during cleanup.        |

Tests: `bridgePipeliningE2e.test.ts`, `statelessNotificationsE2e.test.ts`, and
`libraryConfiguration.test.ts`. The latter also executes stateless HTTP's
previously unobserved catch path and verifies repeated 500 responses plus a
working health endpoint. It only observes the true side of `!res.headersSent`,
so it does not claim MC/DC for that guard.

Pipelining is robustness coverage, not a claim that clients should skip the
initialization wait. Tests accept either a correctly correlated startup error
or a correctly shaped tool result depending on scheduling, while requiring
successful initialization and continued usability. No internal timing state
or SDK method is modified.

## Complete remaining-condition inventory

Paths in the table are relative to `src/`. Repeated predicates at different
locations count separately.

| Location                                                                                                                     | Missing condition(s)                                 |  Count | Classification / reason                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gateways/sseToStdio.ts:160`                                                                                                 | `err`; `typeof err === 'object'`                     |      2 | No ordinary wire witness: observed network/SDK failures are error objects, not falsy or truthy primitive throws.                                                                             |
| `gateways/sseToStdio.ts:164`                                                                                                 | `err`; `typeof err === 'object'`; `'message' in err` |      3 | Same boundary constraint, additionally requiring a thrown object without a message.                                                                                                          |
| `gateways/streamableHttpToStdio.ts:161`                                                                                      | `err`; `typeof err === 'object'`                     |      2 | Same error-object constraint.                                                                                                                                                                |
| `gateways/streamableHttpToStdio.ts:165`                                                                                      | `err`; `typeof err === 'object'`; `'message' in err` |      3 | Same error-object/message constraint.                                                                                                                                                        |
| `gateways/sseToStdio.ts:182`; `gateways/streamableHttpToStdio.ts:183`                                                        | `result.hasOwnProperty('error')` in each bridge      |      2 | Reachable, but correct-behavior regression fails (GW-002). Kept TODO; do not assert corrupted results as intended behavior.                                                                  |
| `gateways/stdioToSse.ts:50`; `gateways/stdioToStatefulStreamableHttp.ts:52`; `gateways/stdioToStatelessStreamableHttp.ts:81` | `Object(headers).length` in each gateway             |      3 | Broken header diagnostic (GW-006). Ordinary headers have no length property; a contrived header named length would exercise the bug, not validate the intended check.                        |
| `gateways/stdioToStatelessStreamableHttp.ts:169`                                                                             | `pendingOriginalMessage`                             |      1 | Internal invariant: setting auto-initialization sets a pending message first; clearing it resets the flag in the same callback (assuming non-reentrant logging).                             |
| `gateways/stdioToStatelessStreamableHttp.ts:210`                                                                             | `!isInitialized`                                     |      1 | Current lifecycle: each POST owns fresh state, and SDK messages are delivered synchronously before child initialization responses arrive.                                                    |
| `gateways/stdioToStatelessStreamableHttp.ts:233`                                                                             | `isInitializeRequest(msg)`                           |      1 | Same lifecycle plus earlier return: while uninitialized, every non-initialize message returns before this check.                                                                             |
| `gateways/stdioToStatelessStreamableHttp.ts:233`                                                                             | `msg.id !== undefined`                               |      1 | Wire/schema: after ID presence is true, JSON cannot supply undefined and SDK-validated request IDs are strings/numbers.                                                                      |
| `gateways/stdioToWs.ts:101`                                                                                                  | `child?.killed`                                      |      1 | Current CLI lifecycle: cleanup kills the child and exits synchronously; no health request runs between those operations.                                                                     |
| `gateways/stdioToWs.ts:105`                                                                                                  | `!isReady`                                           |      1 | Current lifecycle: readiness is set before listening and is never reset.                                                                                                                     |
| `gateways/stdioToSse.ts:118`                                                                                                 | `sessionId`                                          |      1 | SDK contract: SSEServerTransport constructs the ID with randomUUID before exposing it.                                                                                                       |
| `gateways/stdioToStatefulStreamableHttp.ts:102`                                                                              | `transport`                                          |      1 | Current non-reentrant lifecycle: every external map deletion clears the counter first; timeout cleanup consumes its own timer entry before deleting the transport. See deletion audit below. |
| `index.ts:259`                                                                                                               | `hasStreamableHttp`                                  |      1 | Proven redundant after exactly-one-input validation and the preceding two false transport alternatives.                                                                                      |
| `lib/sessionAccessCounter.ts:68`                                                                                             | `session.accessCount <= 0`                           |      1 | Non-reentrant public API invariant: reaching zero replaces the active entry with a timer entry. Duplicate decrements take the timer guard first.                                             |
| **Total**                                                                                                                    |                                                      | **25** |                                                                                                                                                                                              |

## What that means for further test-only gains

- **5 conditions are tied to documented bugs:** two result checks and three
  header checks. Correctness tests remain TODO until fixes are authorized.
- **10 concern arbitrary thrown values:** a focused fault-injection test could
  reach them, but no ordinary network input has been found. Artificial logger
  throws or replaced SDK methods are not included just to make the metric green.
- **10 are constrained by the current control flow, wire representation, SDK
  construction, or non-reentrant state invariants.** This is scoped reasoning,
  not a promise that future dependency or lifecycle changes cannot reach them.

There is no demonstrated path to literal 100% under the current test-only,
no-artificial-state constraints. Continue testing meaningful external failure
and lifecycle behavior, but do not count failing TODOs, change intended
assertions to bless bugs, or silently remove conditions from the denominator.

## Focused disconnect/child-exit/timeout follow-up

Five passing tests in `tests/httpLifecycleE2e.test.ts` check:

- Pending HTTP requests settle after the MCP child exits, in both stateful and
  stateless modes; the gateway remains healthy and accepts a fresh client.
- A WebSocket gateway propagates the child's failure exit status while a tool
  request is pending and closes the client's connection.
- An active stateful request survives longer than the configured idle timeout;
  after its client disconnects, the session expires and its child terminates.
- A child exit cancels a pending idle-cleanup timer; waiting beyond its deadline
  does not produce a stale timeout callback, and a fresh session still works.

These tests exercise real sockets, SDK peers, subprocess exit, and actual
timers. A separate local HTTP control connection releases pending tool work;
there are no private-state edits or replaced SDK methods.

The two previously unresolved MC/DC guards were not reached on their missing
sides: the timer is canceled before a missing-transport callback can run, and
late HTTP reply failures reject asynchronously outside the response-header
catch block. The latter is now an ordinary-disconnect reproduction of GW-004
for both HTTP modes, retained as two TODOs. These are concrete experiment
results, not a proof that every conceivable error/lifecycle path is impossible.

## Latest follow-up: two more conditions reached

Three new passing E2E cases add two independent-condition witnesses:

- Both reverse bridges reject a pipelined initialize request missing its
  protocol version, preserve the first handshake, and handle later tool calls.
  The SSE wrapper observes `[true, true, false]` as well as `[true, true, true]`.
  The earlier assumption that this operand only sees SDK-generated input was
  too restrictive: a client request can reach it during startup.
- A deeply nested malformed HTTP notification completes without taking down
  the stateless gateway, and a later tool call succeeds. An error escapes after
  the notification response has ended, reaching `!res.headersSent === false`.
  The existing empty-command public-API test supplies the true witness.

These cases are in `bridgePipeliningE2e.test.ts` and
`httpDeepInputE2e.test.ts`. Run `run_067c733636cd5017` confirms both witness
pairs in the passing suite, without exclusions or failed-run merging.

The request-shaped deep-input companion hangs rather than completing. It is
GW-009, documented in `MCDC_E2E_FINDINGS_DEEP_INPUT.md` and retained as a TODO.
The passing notification test asserts failure containment, not support for
unlimited nesting or successful delivery of a malformed notification.

## Session termination and timeout-range follow-up

`sessionTerminationE2e.test.ts` deletes a session while both a standalone SSE
stream and a tool request are active. Both exchanges settle, child work stops,
and waiting beyond the idle deadline produces no old-session timer callback.
A fresh session initializes normally. `sessionTimeoutRangeE2e.test.ts` also
checks that a one-day timeout does not expire a session after 100 ms.

The 30-day companion reproduces GW-010: Node clamps the accepted value to
1 ms and the session expires almost immediately. It remains TODO, with details
in `MCDC_E2E_FINDINGS_SESSION_TIMEOUT.md`; it adds no passing-suite coverage.

### Complete transport-deletion audit

There are three transport-map deletion sites in the stateful gateway:

- Lines 179–184: `onclose` clears counter state and any pending timer before
  deleting the transport.
- Lines 192–197: `onerror` uses the same ordering.
- Lines 102–105: timeout cleanup looks up and closes the transport before
  deleting it. Its counter callback has already removed the consumed timer
  entry before calling cleanup (`sessionAccessCounter.ts:85–88`).

The gateway never requests the counter's optional explicit cleanup callback.
The installed transport's `close()` invokes `onclose` synchronously, and these
map operations contain no await points. Under normal event-loop ordering and
non-reentrant logging, neither close nor error leaves a timer targeting a
deleted transport. Completion events arriving afterward call `dec` on an
absent counter entry, which returns without scheduling another timer.

This narrows the last previously unresolved guard to a current lifecycle
invariant, supported by source review and the deletion/child-exit tests. It is
not a recommendation to remove the defensive check, or a claim about future
SDK implementations, custom reentrant loggers, or externally mutated state.

The existing 104/129 result is the demonstrated high-level coverage, not a
universal mathematical maximum. No new clean witness for the remaining 25
conditions has been found in this follow-up. Literal 100% would require
addressing bugs and/or relaxing the present test-only, realistic-boundary
constraints; adding arbitrary thrown values just for coverage is not included.

Run `run_996e518044a55cb9` confirms unchanged coverage with 62 passing tests,
21 unexecuted TODOs, zero failures, and zero measurement limitations.

## Upstream wire-error follow-up

Three passing tests in `bridgeWireResponsesE2e.test.ts` send malformed response
envelopes through actual SSE and HTTP connections. Primitive or malformed
`error` fields are rejected by SDK envelope validation before becoming request
exceptions. Event-stream validation ignores bad frames while allowing a later
valid reply; direct-JSON validation rejects with a normal error object. The
tests verify correlated responses and continued usability, not log text alone.

The remaining ten arbitrary-throw conditions are therefore still missing:
these real wire values do not make `err` falsy, make it a primitive, or remove
the exception's message property. No SDK methods or abort reasons are replaced.

The same audit reproduced two valid-data failures in both reverse bridges:
an application field named `hasOwnProperty` crashes response construction
(GW-011), and structured protocol `error.data` disappears (GW-012). Four TODOs
retain those failures; see `MCDC_E2E_FINDINGS_WIRE_RESPONSES.md`. They do not
provide passing-suite coverage or authorize production fixes.

Run `run_601743121289961b` confirms 104/129 MC/DC with 65 passing tests,
25 unexecuted TODOs, zero failures, and zero measurement limitations.
