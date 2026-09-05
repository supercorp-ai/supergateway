# MC/DC progress: first end-to-end test batch

2026-09-05, Node 24.18.0.

## Result

Added 24 CLI/network end-to-end tests in `tests/gatewayE2e.test.ts`.
The regular suite now has 32 passing tests. No production source changes,
coverage exclusions, private-state manipulation, or SDK method mocks.

| Metric   | Original 8-test suite | Current 32-test suite |
| -------- | --------------------- | --------------------- |
| MC/DC    | 17/129 (13.18%)       | 89/129 (68.99%)       |
| Lines    | 498/818 (60.88%)      | 762/818 (93.15%)      |
| Branches | 138/368 (37.50%)      | 304/368 (82.61%)      |

Original run: `run_331f4b2e9e5a3a9a`.
Current run: `run_96322890cc45f94f`, valid and non-stale when checked.
All 32 outcomes are passed; zero measurement limitations or evidence corruption.
This run took about 20.4 seconds for the test command and 22.3 seconds overall.
The previous disposable 12-test experiment was not installed in the repository;
this batch obtains its gains through the actual CLI and network boundaries.

The MC/DC denominator remains 129. The 72 additional covered conditions are
from new test evidence, not removing source from the measured model. Coverage
is execution evidence, not a guarantee that every fault is caught by assertions.

## What is exercised

- Invalid and conflicting CLI inputs, unsupported transport combinations,
  invalid timeout values, invalid URLs, and logging modes.
- Real HTTP health endpoints, authorization override, custom headers with
  colons, invalid header entries, wildcard/list/regex CORS, and denied origins.
- Stateful HTTP missing/unknown/deleted/expired sessions; malformed envelopes
  before and after initialization; session recovery; an active SSE stream
  keeping a session alive across the idle timeout; graceful DELETE cleanup.
- Stateless HTTP initialization, automatic initialization for standalone
  tool requests, and GET/DELETE rejection.
- Both reverse bridges with explicit/default client metadata, tool responses,
  JSON-RPC errors, real injected HTTP 503 failures, retry recovery, and header
  forwarding. The outage injector is an actual local HTTP proxy; healthy
  traffic reaches the actual gateway and SDK MCP peer.
- SSE request forwarding, invalid session handling, and noisy peer stdout/stderr.
- WebSocket colliding request IDs across two clients, notifications broadcast
  to both, malformed frames, disconnection, late-reply isolation, optional
  CORS/health configuration, invalid route configuration, and shutdown.

`tests/helpers/gateway-process.ts` supplies bounded readiness checks, ephemeral
port allocation, JSON-RPC HTTP helpers, and process-group cleanup. It waits for
observable events rather than fixed startup sleeps. A race found during a
repeat run was fixed by waiting for diagnostics independently of RPC replies:
stdout, stderr, and the response socket are separate streams.

`tests/helpers/noisy-mcp-server.js` is an external SDK MCP peer fixture with
ordinary tool responses, logging notifications, a delayed reply, and noisy
stdio. It does not replace or patch gateway internals.

## Re-run

```sh
# Load nvm in your shell first.
nvm use 24
npm run build
npx --no-install tsc --noEmit
TS_NODE_TRANSPILE_ONLY=true npm test
```

The repository's existing ts-node typechecking-loader failure still requires
`TS_NODE_TRANSPILE_ONLY=true`, even though a separate `tsc --noEmit` check passes.
A plain `npm test` run was attempted and failed during loader startup in both
old and new test files. No test-runner configuration was changed in this batch.
Build, typecheck, and both full native/instrumented suites passed (32/32 each).
The final native suite took about 17.3 seconds.

## Remaining 40 MC/DC obligations, ranked by count

| File                                             | Missing conditions |
| ------------------------------------------------ | -----------------: |
| `src/gateways/sseToStdio.ts`                     |                  9 |
| `src/gateways/stdioToStatelessStreamableHttp.ts` |                  8 |
| `src/gateways/streamableHttpToStdio.ts`          |                  8 |
| `src/lib/sessionAccessCounter.ts`                |                  4 |
| `src/gateways/stdioToWs.ts`                      |                  3 |
| `src/server/websocket.ts`                        |                  2 |
| `src/gateways/stdioToSse.ts`                     |                  2 |
| `src/gateways/stdioToStatefulStreamableHttp.ts`  |                  2 |
| `src/index.ts`                                   |                  1 |
| `src/lib/onSignals.ts`                           |                  1 |

Header parsing, CORS parsing/serialization, and logger selection have no
remaining MC/DC gaps. `getVersion.ts` has no MC/DC conditions; that does not
mean all of its other coverage obligations are satisfied.

## Next efficient batch

1. Fix the independently reproduced fallback-initialization crash in both
   reverse bridges, then promote the manual failing reproducer into the normal
   end-to-end suite. See `MCDC_E2E_FINDINGS.md`.
2. Correct the three header-presence log checks and assert their diagnostics
   through the CLI. These checks currently use `Object(headers).length`.
3. Investigate stateless request sequencing and remaining disconnect/error
   paths at the HTTP boundary. Do not assume all eight gaps are reachable:
   several checks are constrained by prior SDK validation.
4. Review remaining defensive/unreachable conditions before selecting a small
   number of public-API component tests. Do not mutate private state or invent
   impossible SDK behavior merely to force 100%.

The separate fallback reproducer fails in a normal CLI run and is not included
in the passing-suite metric. No production fixes are included in this first
test batch.
