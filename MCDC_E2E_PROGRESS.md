# MC/DC progress: tests and bug documentation only

2026-09-05, Node 24.18.0.

## Current result

The default suite has **47 passing tests and 14 TODOs**, with zero failures.
There are no production source changes relative to the PR base. Previously
attempted bug fixes have been removed; the old 87.60% result does not describe
the current branch.

| Metric   | Original 8 tests | Current default suite |
| -------- | ---------------- | --------------------- |
| MC/DC    | 17/129 (13.18%)  | 98/129 (75.97%)       |
| Lines    | 498/818 (60.88%) | 785/818 (95.97%)      |
| Branches | 138/368 (37.50%) | 315/368 (85.60%)      |

Current measured run: `run_1a72e3cd3bae8eda`, with zero measurement limitations.
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

`MCDC_E2E_FINDINGS.md` records seven identified issues, distinguishing observed
failures from code-level findings and missing independent reproductions.

- Twelve TODOs retain opt-in CLI/network reproduction bodies: four fallback,
  two successful-result preservation, two stateless sequencing/batch, one
  stateful stale-response case, and three header-diagnostic cases.
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
runs both report 47 passed, 14 TODO, zero failed.

The existing ts-node typechecking-loader issue requires
`TS_NODE_TRANSPILE_ONLY=true` in this environment despite standalone TypeScript
checking passing. Runner configuration remains unchanged.

## Remaining work

31 MC/DC conditions remain. These include documented bugs, defensive lifecycle
paths, and conditions constrained by earlier CLI/SDK validation. Continue
adding high-level tests and recording bugs, without fixing production code or
removing safety checks until explicitly requested. This is not 100% MC/DC.

## Latest test-only increment

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
