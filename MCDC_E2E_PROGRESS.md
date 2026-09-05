# MC/DC progress

2026-09-05, Node 24.18.0.

## Result

The regular suite now has 52 passing tests, up from 8. Tests prioritize real
CLI processes, local HTTP/SSE/WebSocket connections, and SDK peers. Focused
public-API tests cover signal ownership, session cleanup, WebSocket lifecycle,
and shared error normalization. No coverage exclusions, private-state mutation,
or SDK method mocks were added.

| Metric   | Original 8 tests | First 32 tests   | Current 52 tests |
| -------- | ---------------- | ---------------- | ---------------- |
| MC/DC    | 17/129 (13.18%)  | 89/129 (68.99%)  | 106/121 (87.60%) |
| Lines    | 498/818 (60.88%) | 762/818 (93.15%) | 786/821 (95.74%) |
| Branches | 138/368 (37.50%) | 304/368 (82.61%) | 316/362 (87.29%) |

The current measured run is `run_51f7bc3aece99b63`: 52 passed, zero measurement
limitations or evidence corruption. A separate native run also passed all 52
tests. Build and standalone TypeScript checking passed.

The MC/DC denominator changed from 129 to 121 because production bugs were
fixed and duplicated error normalization was consolidated: two erroneous
success-result checks were removed; fourteen duplicated normalization
conditions were replaced by eight shared conditions. This is not an unchanged
source comparison, and no source was excluded from measurement. Coverage is
execution evidence, not a guarantee that every fault is caught by assertions.

## Behavior exercised

- CLI validation, transport selection, timeout validation, URL validation,
  logging modes, header parsing, authorization precedence, and CORS variants.
- HTTP health checks, malformed envelopes, missing/unknown/deleted/expired
  sessions, idle timeout recovery, and active SSE streams delaying cleanup.
- Stateless initialization, batched tool requests, zero request IDs,
  interleaved notifications, stale replies, and unsupported HTTP methods.
- Both reverse bridges with explicit/default metadata, fallback initialization,
  successful results containing diagnostic error data, protocol errors, real
  upstream HTTP failures, retry recovery, and header forwarding.
- SSE forwarding, invalid session handling, and noisy peer stdout/stderr.
- WebSocket colliding IDs across clients, broadcast notifications, malformed
  frames, disconnects, late replies, closing peers, and detached handlers.
- SIGINT, SIGTERM, SIGHUP, and stdin EOF with and without a cleanup callback;
  public session-counter cleanup modes; malformed error normalization inputs.

Process helpers use bounded readiness checks, ephemeral ports, and process-group
cleanup. External wire/SDK peers exercise actual transport behavior; they do
not replace gateway internals. See `MCDC_E2E_FINDINGS.md` for regression fixes.

## Re-run

```sh
# Load nvm in your shell first.
nvm use 24
npm run build
npx --no-install tsc --noEmit
TS_NODE_TRANSPILE_ONLY=true npm test
```

The existing ts-node typechecking-loader failure requires
`TS_NODE_TRANSPILE_ONLY=true` on this environment, although standalone
`tsc --noEmit` passes. Plain `npm test` fails during loader startup in both old
and new files. Test-runner configuration was not changed.

## Remaining 15 MC/DC conditions

| File                                             | Missing conditions |
| ------------------------------------------------ | -----------------: |
| `src/gateways/stdioToStatelessStreamableHttp.ts` |                  5 |
| `src/gateways/stdioToWs.ts`                      |                  3 |
| `src/gateways/sseToStdio.ts`                     |                  2 |
| `src/gateways/streamableHttpToStdio.ts`          |                  1 |
| `src/gateways/stdioToSse.ts`                     |                  1 |
| `src/gateways/stdioToStatefulStreamableHttp.ts`  |                  1 |
| `src/lib/sessionAccessCounter.ts`                |                  1 |
| `src/index.ts`                                   |                  1 |

Header parsing, CORS parsing/serialization, logger selection, shared error
normalization, signal handling, and the public WebSocket transport have no
remaining MC/DC gaps. This does not imply 100% of their other coverage metrics.

The remaining conditions include redundant CLI checks, SDK-validated inputs,
and defensive lifecycle guards. Some are provably unreachable through the
current CLI; others still require reachability analysis. The next decision is
whether to simplify proven-redundant production branches while preserving
safety guards, or retain them with documented infeasible independence pairs.
The current result is not 100% MC/DC.
