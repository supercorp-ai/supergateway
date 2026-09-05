# MC/DC reachability audit

2026-09-05. Production sources are unchanged from the PR base. The passing
suite covers 102/129 conditions (79.07%); 27 remain. This inventory counts
individual conditions, not decisions or lines. No exclusions or adjusted
denominators are used.

## Four previously missing conditions now reached

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

| Location                                                                                                                     | Missing condition(s)                                 |  Count | Classification / reason                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | -----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `gateways/sseToStdio.ts:130`                                                                                                 | `requestMessage.params?.protocolVersion`             |      1 | SDK contract: a generated initialize request has a nonempty version; a non-initialize request short-circuits before this operand.                                                    |
| `gateways/sseToStdio.ts:160`                                                                                                 | `err`; `typeof err === 'object'`                     |      2 | No ordinary wire witness: observed network/SDK failures are error objects, not falsy or truthy primitive throws.                                                                     |
| `gateways/sseToStdio.ts:164`                                                                                                 | `err`; `typeof err === 'object'`; `'message' in err` |      3 | Same boundary constraint, additionally requiring a thrown object without a message.                                                                                                  |
| `gateways/streamableHttpToStdio.ts:161`                                                                                      | `err`; `typeof err === 'object'`                     |      2 | Same error-object constraint.                                                                                                                                                        |
| `gateways/streamableHttpToStdio.ts:165`                                                                                      | `err`; `typeof err === 'object'`; `'message' in err` |      3 | Same error-object/message constraint.                                                                                                                                                |
| `gateways/sseToStdio.ts:182`; `gateways/streamableHttpToStdio.ts:183`                                                        | `result.hasOwnProperty('error')` in each bridge      |      2 | Reachable, but correct-behavior regression fails (GW-002). Kept TODO; do not assert corrupted results as intended behavior.                                                          |
| `gateways/stdioToSse.ts:50`; `gateways/stdioToStatefulStreamableHttp.ts:52`; `gateways/stdioToStatelessStreamableHttp.ts:81` | `Object(headers).length` in each gateway             |      3 | Broken header diagnostic (GW-006). Ordinary headers have no length property; a contrived header named length would exercise the bug, not validate the intended check.                |
| `gateways/stdioToStatelessStreamableHttp.ts:169`                                                                             | `pendingOriginalMessage`                             |      1 | Internal invariant: setting auto-initialization sets a pending message first; clearing it resets the flag in the same callback (assuming non-reentrant logging).                     |
| `gateways/stdioToStatelessStreamableHttp.ts:210`                                                                             | `!isInitialized`                                     |      1 | Current lifecycle: each POST owns fresh state, and SDK messages are delivered synchronously before child initialization responses arrive.                                            |
| `gateways/stdioToStatelessStreamableHttp.ts:233`                                                                             | `isInitializeRequest(msg)`                           |      1 | Same lifecycle plus earlier return: while uninitialized, every non-initialize message returns before this check.                                                                     |
| `gateways/stdioToStatelessStreamableHttp.ts:233`                                                                             | `msg.id !== undefined`                               |      1 | Wire/schema: after ID presence is true, JSON cannot supply undefined and SDK-validated request IDs are strings/numbers.                                                              |
| `gateways/stdioToStatelessStreamableHttp.ts:256`                                                                             | `!res.headersSent`                                   |      1 | Partially reached through the public API; no demonstrated failure escaping the SDK after response headers are sent. Retain as an unresolved safety guard.                            |
| `gateways/stdioToWs.ts:101`                                                                                                  | `child?.killed`                                      |      1 | Current CLI lifecycle: cleanup kills the child and exits synchronously; no health request runs between those operations.                                                             |
| `gateways/stdioToWs.ts:105`                                                                                                  | `!isReady`                                           |      1 | Current lifecycle: readiness is set before listening and is never reset.                                                                                                             |
| `gateways/stdioToSse.ts:118`                                                                                                 | `sessionId`                                          |      1 | SDK contract: SSEServerTransport constructs the ID with randomUUID before exposing it.                                                                                               |
| `gateways/stdioToStatefulStreamableHttp.ts:102`                                                                              | `transport`                                          |      1 | No demonstrated missing-transport timeout callback. Close/error paths clear counter timers before deleting the transport. Keep the defensive check; not claimed globally impossible. |
| `index.ts:259`                                                                                                               | `hasStreamableHttp`                                  |      1 | Proven redundant after exactly-one-input validation and the preceding two false transport alternatives.                                                                              |
| `lib/sessionAccessCounter.ts:68`                                                                                             | `session.accessCount <= 0`                           |      1 | Non-reentrant public API invariant: reaching zero replaces the active entry with a timer entry. Duplicate decrements take the timer guard first.                                     |
| **Total**                                                                                                                    |                                                      | **27** |                                                                                                                                                                                      |

## What that means for further test-only gains

- **5 conditions are tied to documented bugs:** two result checks and three
  header checks. Correctness tests remain TODO until fixes are authorized.
- **10 concern arbitrary thrown values:** a focused fault-injection test could
  reach them, but no ordinary network input has been found. Artificial logger
  throws or replaced SDK methods are not included just to make the metric green.
- **10 are constrained by the current control flow, wire representation, SDK
  construction, or non-reentrant state invariants.** This is scoped reasoning,
  not a promise that future dependency or lifecycle changes cannot reach them.
- **2 safety guards remain without full witness pairs:** response headers already
  sent during an escaping stateless failure, and missing transport during a
  stateful timeout. They are investigation targets, not proven dead code.

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
