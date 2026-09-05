# MC/DC progress: tests and bug documentation only

2026-09-05, Node 24.18.0.

## Current result

The default suite has **62 passing tests and 21 TODOs**, with zero failures.
There are no production source changes relative to the PR base. Previously
attempted bug fixes have been removed; the old 87.60% result does not describe
the current branch.

| Metric   | Original 8 tests | Current default suite |
| -------- | ---------------- | --------------------- |
| MC/DC    | 17/129 (13.18%)  | 104/129 (80.62%)      |
| Lines    | 498/818 (60.88%) | 795/818 (97.19%)      |
| Branches | 138/368 (37.50%) | 321/368 (87.23%)      |

Current measured run: `run_996e518044a55cb9`, with zero measurement limitations.
The original source denominator of 129 is restored. Default TODO bodies do not
execute and contribute no coverage. Opt-in failing reproductions are not merged
into this result. Coverage is execution evidence, not proof of assertion quality.

## Test approach

Tests prioritize real compiled CLI processes, local HTTP/SSE/WebSocket
connections, and SDK peers. They exercise CLI validation, headers/CORS, HTTP
outages and recovery, session lifecycle, malformed requests, routing,
broadcasts, and late-reply isolation.

Focused public-API tests cover session-counter cleanup, WebSocket handler
detachment and closing peers, and process signal/EOF handling. There are no
coverage exclusions, private-state mutations, or SDK method mocks.
Process helpers provide bounded readiness checks and process-group cleanup.

## Known bugs stay pending

`MCDC_E2E_FINDINGS.md` records eight identified issues, distinguishing observed
failures from code-level findings and missing independent reproductions.
`MCDC_E2E_FINDINGS_DEEP_INPUT.md` records the ninth, a hung deep-input request.
`MCDC_E2E_FINDINGS_SESSION_TIMEOUT.md` records the tenth, immediate expiration
of an accepted 30-day idle timeout.

- Seventeen TODOs retain opt-in CLI/network reproduction bodies: four fallback,
  two successful-result preservation, two stateless sequencing/batch, one
  stateful stale-response case, three header-diagnostic cases, and three
  inherited-property session-ID cases, plus two ordinary-disconnect/late-reply
  cases (one per HTTP mode).
- One further executable TODO retains the deep-input request regression.
- One executable TODO retains the 30-day idle-timeout regression.
- Two error-normalization TODOs are specifications only. They do not import a
  nonexistent proposed helper and do not claim executable reproduction.
- Ordinary passing tests remain enabled, including actual header delivery.

Set `RUN_KNOWN_BUG_TESTS=1` to execute the reproduction bodies as ordinary tests.
They should fail until the bugs are fixed. The findings document gives the
focused command. A spot-check of both result-preservation and all three
header-diagnostic cases produced the five expected assertion failures.

## Validation

```sh
# Load nvm in your shell first.
nvm use 24
npm run build
npx --no-install tsc --noEmit
TS_NODE_TRANSPILE_ONLY=true npm test
```

Build and standalone TypeScript checking pass. Native and measured full-suite
runs both report 62 passed, 21 TODO, zero failed.

The existing ts-node typechecking-loader issue requires
`TS_NODE_TRANSPILE_ONLY=true` in this environment despite standalone TypeScript
checking passing. Runner configuration remains unchanged.

## Remaining work

25 MC/DC conditions remain. These include documented bugs, defensive lifecycle
paths, and conditions constrained by earlier CLI/SDK validation. Continue
adding high-level tests and recording bugs, without fixing production code or
removing safety checks until explicitly requested. This is not 100% MC/DC.

## Previous test-only increment: initialization rejection

Five tests in `tests/initializationLifecycleE2e.test.ts` cover both reverse
bridges terminating with a nonzero status when the upstream rejects explicit
or fallback initialization, plus stateless HTTP handling an interleaved
notification before its automatic initialization reply. They use real CLI
chains and an external JSON-RPC peer, with no mocked gateway/SDK methods.

This adds three independent-condition witnesses: the first-request method
choice in each reverse bridge, and the stateless initialization-response ID
match. MC/DC increased from 95/129 to 98/129 with no production changes.
The existing successful-fallback bugs remain TODO; exercising rejected
initialization does not claim those bugs are fixed.

The findings document now has seven separately labeled dead-code/lifecycle
analyses (DC-001 through DC-007), distinguishing proofs from SDK constraints
and unclassified guards. It also records a freshly reproduced stateful variant
of the unchecked transport-send crash (GW-004), retained as an opt-in TODO.

## Previous test-only increment: reachability audit

Five additional tests cover pipelined startup on both reverse bridges, stateless
notification handling, and empty child-command configuration through the
exported WebSocket/stateless gateway APIs. They add four independent-condition
witnesses without changing source or injecting faults into SDK methods.

At that stage, 27 conditions remained. Five were tied to known bugs, ten needed
arbitrary thrown values with no demonstrated ordinary wire input, ten were
constrained by current flow/schema/state, and two safety guards lacked full
witness pairs. None were excluded from the reported metric.

The audit also reproduced GW-008: an inherited-property session ID crashes
stateful HTTP through POST, GET, and DELETE. Three new TODOs preserve those
failures. Passing-suite coverage does not include the opt-in failing runs.

## Previous test-only increment: focused lifecycle follow-up

Five tests in `tests/httpLifecycleE2e.test.ts` exercise child death during pending
requests in both HTTP modes and WebSocket, active work surviving the idle
timeout, cleanup after disconnect, and cancellation of idle cleanup after
child exit. HTTP gateways remain healthy and accept fresh clients; WebSocket
propagates the child's failure status. The time-based assertions deliberately
wait beyond the configured timeout, while request sequencing uses observable
network events rather than guessed startup sleeps.

Two additional TODOs in `tests/httpDisconnectRegressionE2e.test.ts` reproduce
GW-004 with ordinary client disconnects followed by legitimate tool replies,
not unsolicited IDs. Both HTTP gateway processes crash. An external SDK peer
and local HTTP control connection make the tool's start and completion
observable without replacing SDK methods or editing private state.

The two unresolved MC/DC guards were not covered on their missing sides by
these scenarios. The timeout is canceled before a stale callback runs, and the
late-reply failure is an asynchronous send rejection outside the HTTP handler
catch. This is additional lifecycle evidence, not a claim of a higher MC/DC
ceiling or of bug fixes.

That passing measurement remained at 102/129 MC/DC (79.07%). Line coverage
increased from 788/818 (96.33%) to 795/818 (97.19%), and branch coverage from
319/368 (86.68%) to 320/368 (86.96%). The 27-condition inventory was unchanged.

An earlier measured attempt had two port-in-use startup failures while another
test command overlapped it. That failed run is diagnostic only and is not
merged into the passing-suite coverage; full verification is run serially.

## Previous test-only increment: malformed startup and deep input

Two passing pipelined-startup tests reject an initialize request without a
protocol version while preserving the valid handshake and later tool replies.
One passing deep-notification test verifies HTTP completion, gateway health,
and a subsequent tool call. These reach the SSE wrapper's version-presence
condition and the stateless response-header guard's missing side.

MC/DC increases from 102/129 (79.07%) to 104/129 (80.62%). Branch coverage
increases to 321/368 (87.23%); lines remain 795/818 (97.19%). The remaining
25-condition inventory comprises five tied to known bugs, ten arbitrary-throw
conditions without ordinary wire witnesses, nine current flow/schema/state
constraints, and one unresolved timeout guard.

The deeply nested request companion reproduces GW-009: the HTTP exchange
hangs after a header error while the health endpoint still returns 200. It is
kept as a TODO and documented in a new findings file. Native and measured
default suites pass serially; the opt-in reproduction is not merged into them.

## Latest follow-up: session termination and timeout range

Two passing E2E tests cover deletion during concurrent SSE/tool work and a
one-day idle timeout retaining its session. DELETE settles both active HTTP
exchanges, stops child work, cancels idle cleanup, and permits a fresh session.
The 30-day companion reproduces GW-010 and remains an opt-in TODO.

The full suite passes natively and under measurement. Coverage is unchanged:
104/129 MC/DC, 795/818 lines, and 321/368 branches. No failing reproduction
is included in those totals.

Source review traced all three stateful transport-map deletion sites and the
counter's timer lifecycle. Under current non-reentrant operation, a pending
cleanup timer cannot outlive removal of its transport. The reachability audit
now groups that remaining guard with current lifecycle constraints, rather
than treating it as an unexplored ordinary-scheduling case. Safety guards and
production sources remain untouched.

The 25 missing conditions now group as five tied to known bugs, ten involving
arbitrary thrown values without ordinary wire witnesses, and ten constrained
by current flow/schema/state. No additional clean E2E witness was found in this
follow-up; 80.62% remains the demonstrated result, not a universal maximum.
