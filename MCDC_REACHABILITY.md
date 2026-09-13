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

## Branch-outcome follow-up (not MC/DC conditions)

The inventory above tracks MC/DC conditions. A separate sweep of plain branch
outcomes found ten that no test had taken and that no entry above explains.
Five passing tests now reach twelve of them, taking branch coverage from
335/368 to 347/368 and value selections from 28/36 to 32/36. No production file
was touched and no known-bug TODO was converted into an assertion of broken
behavior.

| Reached                                                                                                                                | Test                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `server/websocket.ts:56,62,66,94,103` — every optional `onerror`/`ondisconnection` notification with no handler registered             | `websocketOptionalCallbacks.test.ts`: a transport built without those callbacks still parses frames, absorbs a malformed one, and removes clients dropped by a targeted send, a broadcast and a close. Each socket is made ready again afterwards, so continued silence proves removal rather than skipping. |
| `sseToStdio.ts:106,112`, `streamableHttpToStdio.ts:104,110` — the `\|\| '2.0'` default and the left side of the request classification | `bridgeInputShapes.test.ts`: a request omitting `jsonrpc` is answered with the default version under its own id, and a frame carrying no method is relayed byte-identical instead of being re-wrapped.                                                                                                       |
| `stdioToSse.ts:181` — the zero-session fan-out                                                                                         | `sseEarlyChildOutput.test.ts`: child output produced before any client connects is parsed and logged with no session to receive it, and a client connecting afterwards gets only later messages, so nothing is buffered and replayed.                                                                        |
| `sseToStdio.ts:74` — the `init = {}` default                                                                                           | `sseFetchHeaders.test.ts`: the configured event-source fetch merges headers over a supplied init and still applies them when called with the URL alone.                                                                                                                                                      |
| `sseToStdio.ts:132` — the nullish short-circuit on `requestMessage.params`                                                             | `bridgePipelinedInitialize.test.ts`: a second initialize pipelined while the upstream connection is pending reaches the temporary wrapper with no params; it is forwarded unchanged and answered under its own id.                                                                                           |

### Newly classified as unreachable

These were examined in the same sweep and are **not** bugs, TODOs, or candidates
for a test. They are recorded so a later reader does not re-derive them.

| Location                                                                                                                | Outcome                                                | Reason                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stdioToSse.ts:175`, `stdioToWs.ts:73`, `stdioToStatelessStreamableHttp.ts:145`, `stdioToStatefulStreamableHttp.ts:150` | right side of `lines.pop() ?? ''`                      | `String.prototype.split` always yields at least one element, so `pop()` on its result is never `undefined`. The coalesce can never select its right side for any input.                                                                                                                                                   |
| `lib/getLogger.ts:9,20`                                                                                                 | `formatArgs = defaultFormatArgs` destructuring default | `log`/`logStderr` are module-private and are only ever called with no argument — which supplies the whole-object default that already contains `formatArgs` — or with an explicit `formatArgs`. Reaching the destructuring default needs `log({})`, which no caller can express. It is redundant with the object default. |
| `stdioToWs.ts:80`                                                                                                       | nullish short-circuit on `wsTransport?.send`           | The child stdout listener is installed and `wsTransport` is assigned in the same synchronous stretch of `stdioToWs`, with no await between them, so no child `data` event can be delivered while the transport is still null.                                                                                             |

## Mutation audit, hand-picked pass (2026-09-13)

Coverage says which code ran and which decisions were taken. It does not say
whether a change to that code would fail a test. Forty hand-picked mutations
were applied one at a time in a disposable copy, each rebuilt and run against
the whole suite. Five were rejected by the compiler before any test ran and
were re-expressed type-valid; the remaining thirty-five are the measured set.

**33 of 35 killed.** The two survivors are the same defect in each bridge.

Killed mutants span every source file: CORS parsing and regex extraction,
header parsing and bearer precedence, logger routing and TTY colorization,
version reporting, signal handling and stdin cleanup, all five session-counter
transitions, WebSocket client correlation, id parsing, open-socket checks and
every prune path, SSE session registration and rejection codes, request
classification and relay in both bridges, stateful session reuse, and the
stateless auto-initialization gate.

Both survivors are `jsonrpc: req.jsonrpc || '2.0'` in `sseToStdio.ts:106` and
`streamableHttpToStdio.ts:104`. Replacing the expression with the constant
`'2.0'` passes the entire suite. This is recorded as GW-013: the only input
that distinguishes the two forms is a request declaring a non-2.0 version, and
the current code answers it with that same non-conformant version, so killing
the mutant with a test would mean asserting a response that JSON-RPC 2.0
forbids. It is a specification TODO, not a coverage gap.

The lesson for this suite is that the branch in question is covered, its
statement is asserted, and a flow explains it — and none of that detects the
change. Coverage bounds where a defect can hide; it does not establish that one
would be caught.

## Mutation audit, exhaustive pass (2026-09-13)

The pass above was hand-picked, which biases upward: points chosen as
meaningful are points a test is likely to cover. This one enumerates candidates
mechanically over a fixed operator set and runs **every** one, so there is no
selection effect and no sampling error.

Operators: `===`/`!==` both ways, `&&`/`||` both ways, `??`->`||`, `true`/`false`
both ways, `+ 1`->`- 1`, `++`->`--`, across all 16 source files. Relational
operators were excluded after inspection: all 45 candidates were TypeScript
generics, never comparisons. Population: **94 mutations, all run.**

| Outcome                               | Count |
| ------------------------------------- | ----- |
| Killed                                | 50    |
| Rejected by `tsc` before any test ran | 28    |
| Survived                              | 16    |
| Raw kill rate on the 66 measurable    | 75.8% |

That 28 is worth stating separately: **30% of mechanical mutations do not
compile.** The type system is a real part of this project's safety net, and a
raw mutation score hides it.

All 16 survivors were triaged:

- **7 provably equivalent.** `lines.pop() ?? ''` in three gateways (`pop()`
  returns `string | undefined`, and `''` behaves identically under `??` and
  `||`); `let isReady = false` (DC-005: set true before `listen`, so the
  initializer is never read); `isInitialized = true` (DC-002: the only read
  happens before the child's response can arrive); and both `isAutoInitializing`
  assignments, which are dead stores overwritten before their only read.
- **7 near-equivalent.** `??`->`||` where the left side cannot be falsy without
  being nullish: capability objects, `clientId?.split(':')` (always an array),
  and `clientInfo?.name` / `clientInfo?.version`, distinguishable only by a
  client sending an empty string.
- **2 genuine detection gaps**, now closed. See below.

### The gap this found: a clean child exit

`process.exit(code ?? 1)` in `stdioToSse.ts:72` and `stdioToWs.ts:60`. Zero is
the single exit code where `code ?? 1` and `code || 1` disagree, and every
existing child-exit test used 17, 19, 23 or a null code for the signal case. So
nothing verified that a child finishing cleanly leaves the gateway exiting 0
rather than 1 - which is what a supervisor, container runtime or CI step reads.

`tests/childExitCodeZero.test.ts` covers both gateways and was confirmed to fail
against the mutant (`actual [1], expected [0]`).

### Scope of the claim

Zero genuine survivors is scoped to the operator set above. It is not a claim
that no bug can escape. The hand-picked pass used operators this one does not -
statement deletion, constant substitution, argument changes - and that is how
GW-013 was found. Neither method subsumes the other, and neither is exhaustive
over the space of real defects.
