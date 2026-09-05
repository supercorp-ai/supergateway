# MC/DC progress: tests and bug documentation only

2026-09-05, Node 24.18.0.

## Current result

The default suite has **52 passing tests and 17 TODOs**, with zero failures.
There are no production source changes relative to the PR base. Previously
attempted bug fixes have been removed; the old 87.60% result does not describe
the current branch.

| Metric   | Original 8 tests | Current default suite |
| -------- | ---------------- | --------------------- |
| MC/DC    | 17/129 (13.18%)  | 102/129 (79.07%)      |
| Lines    | 498/818 (60.88%) | 788/818 (96.33%)      |
| Branches | 138/368 (37.50%) | 319/368 (86.68%)      |

Current measured run: `run_26c62358324bd0cf`, with zero measurement limitations.
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

- Fifteen TODOs retain opt-in CLI/network reproduction bodies: four fallback,
  two successful-result preservation, two stateless sequencing/batch, one
  stateful stale-response case, three header-diagnostic cases, and three
  inherited-property session-ID cases.
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
runs both report 52 passed, 17 TODO, zero failed.

The existing ts-node typechecking-loader issue requires
`TS_NODE_TRANSPILE_ONLY=true` in this environment despite standalone TypeScript
checking passing. Runner configuration remains unchanged.

## Remaining work

27 MC/DC conditions remain. These include documented bugs, defensive lifecycle
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

## Latest test-only increment: reachability audit

Five additional tests cover pipelined startup on both reverse bridges, stateless
notification handling, and empty child-command configuration through the
exported WebSocket/stateless gateway APIs. They add four independent-condition
witnesses without changing source or injecting faults into SDK methods.

`MCDC_REACHABILITY.md` inventories all 27 remaining conditions. Five are tied to
known bugs, ten need arbitrary thrown values with no demonstrated ordinary wire
input, ten are constrained by current flow/schema/state, and two safety guards
remain without full witness pairs. None are excluded from the reported metric.

The audit also reproduced GW-008: an inherited-property session ID crashes
stateful HTTP through POST, GET, and DELETE. Three new TODOs preserve those
failures. Passing-suite coverage does not include the opt-in failing runs.
