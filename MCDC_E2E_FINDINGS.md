# Known gateway bugs and pending regressions

2026-09-05. These bugs are intentionally **not fixed** in this branch.
Previously attempted production fixes have been removed from the current PR
diff. Ordinary passing behavior tests remain enabled.

## Running pending regressions

The default suite reports known-bug tests as TODO without executing their
bodies. Run the existing CLI/network reproducers as ordinary tests with:

```sh
nvm use 24
npm run build
RUN_KNOWN_BUG_TESTS=1 TS_NODE_TRANSPILE_ONLY=true node --test --test-concurrency=1 --experimental-loader ts-node/esm --experimental-test-module-mocks tests/bridgeFallbackE2e.test.ts tests/bridgeResultE2e.test.ts tests/statelessBatchE2e.test.ts tests/statefulStaleReplyE2e.test.ts tests/httpDisconnectRegressionE2e.test.ts tests/headerDiagnosticsE2e.test.ts tests/sessionLookupRegressionE2e.test.ts
```

This opt-in command is expected to fail until the bugs are fixed. Default TODOs
contribute no execution coverage. The two error-normalization TODOs are
specifications only; no proposed production helper is retained.

## GW-001: fallback initialization loses the first request

Affected: both upstream-to-stdio bridges.

A first non-initialize request connects the fallback SDK client but is never
forwarded. The undefined result crashes response construction on
`hasOwnProperty`.

Four TODOs in `tests/bridgeFallbackE2e.test.ts` cover first tools/list and
unknown-method requests, followed by a subsequent valid request, for both
transports. The tools/list cases reproduced the crash. Unknown-method cases
specify the associated error behavior. This concerns the gateway's explicit
compatibility fallback, not a protocol requirement to skip initialization.

## GW-002: successful results containing an error field are corrupted

Affected: both upstream-to-stdio bridges.

The SDK already rejects protocol errors, but the gateway interprets application
data named `error` inside a successful result as an outer JSON-RPC error.

Two TODOs in `tests/bridgeResultE2e.test.ts` reproduced this with a real SDK
diagnostic tool through actual CLI chains. Expected: preserve the entire result.

## GW-003: stateless batches overwrite pending requests

Affected: `stdioToStatelessStreamableHttp.ts`.

Only one pending message is retained during automatic initialization. A second
message overwrites it and starts another initialization exchange. A two-call
HTTP batch lost responses and could crash when an unexpected initialization
reply reached the transport.

The batch TODO in `tests/statelessBatchE2e.test.ts` failed against the original
implementation. Expected: one initialization exchange and every response
correctly matched to its original request.

## GW-004: rejected HTTP transport sends can crash the process

Affected: `stdioToStatelessStreamableHttp.ts` and
`stdioToStatefulStreamableHttp.ts`.

`transport.send(jsonMsg)` returns a promise, but only synchronous exceptions
are caught. An unsolicited stale response ID can cause an unhandled rejection.

The interleaving/stale-reply TODO in `tests/statelessBatchE2e.test.ts` expects
the error to be reported without stopping subsequent requests. This crash also
occurred during the GW-003 batch reproduction.

The stateful variant is retained in `tests/statefulStaleReplyE2e.test.ts` as an
opt-in TODO regression. It uses a real initialized HTTP session and an external
peer emitting an unsolicited reply before the requested tools-list response.
The opt-in run reproduced process termination with
`No connection established for request ID: stale-peer-request`; the HTTP request
failed with a connection reset. No production fix is included.

### Ordinary disconnects reproduce the same crash

`tests/httpDisconnectRegressionE2e.test.ts` adds two opt-in TODOs, one per HTTP
mode. A real SDK tool starts work; the HTTP client aborts; a successful health
roundtrip confirms the gateway is still serving; then the tool completes with
a normal response carrying the original request ID. Both processes terminate
with `No connection established for request ID: 2`, and the next request fails
because the gateway is gone. Neither malformed traffic nor unsolicited IDs are
needed to trigger this variant.

The external peer waits on a separate local HTTP control connection, letting
the test observe work in flight and release the reply after disconnect. No SDK
method or gateway state is replaced. The stateful case also waits for the
gateway's response-close diagnostic before releasing the reply.

The rejection occurs asynchronously in `transport.send`, outside the outer
HTTP handler's catch block. Consequently this reproducer does not provide a
false-side witness for the stateless `!res.headersSent` guard. Production code
remains unchanged.

## GW-005: initialization ID zero is not recognized

Affected: `stdioToStatelessStreamableHttp.ts`.

`initializeRequestId && jsonMsg.id === initializeRequestId` treats valid ID zero
as absent, skipping initialization bookkeeping.

Confirmed code-level defect. The combined interleaving TODO exercises zero IDs
but does not independently prove an externally visible failure from ID zero
alone. A dedicated regression still needs that observable consequence.

## GW-006: configured headers are logged as absent

Affected: SSE, stateful HTTP, and stateless HTTP server gateways.

`Object(headers).length` is undefined for ordinary header objects, so startup
reports no headers even when they are delivered correctly.

Three TODOs in `tests/headerDiagnosticsE2e.test.ts` assert configured headers
appear in startup logs. Existing passing header-delivery tests remain enabled.

## GW-007: defensive error formatting assumes valid property types

Affected: both upstream-to-stdio bridges.

An object's message is accepted without checking its type, then passed to
`startsWith`. A numeric message can throw in the error handler. Code values
are also copied without validating their type or whether they are finite
integers.

This is a code-level finding, not a demonstrated ordinary SDK/network failure.
Real tested SDK errors have normal properties. Do not mock impossible SDK
behavior to claim an E2E reproduction.

Two specification TODOs in `tests/jsonRpcError.test.ts` reserve these acceptance
cases: null/primitive inputs, missing or malformed fields, non-finite/fractional
codes, valid integer codes including zero, ordinary Error objects,
matching/mismatched protocol prefixes, and no input mutation.
The proposed helper and implementation-dependent tests were removed.
Executable regressions need a justified public boundary.

## GW-008: inherited-property session IDs crash stateful HTTP

Affected: `stdioToStatefulStreamableHttp.ts`, POST and shared GET/DELETE handlers.

The session registry is an ordinary object. Looking up the unissued session ID
`constructor` returns an inherited function instead of an absent entry. The
handler accepts it as a transport and calls its nonexistent `handleRequest`.

Three opt-in TODOs in `tests/sessionLookupRegressionE2e.test.ts` reproduce a
process crash and dropped connection for POST, GET, and DELETE, even before
creating any session. Native stderr reports
`TypeError: transport.handleRequest is not a function`. Expected: reject the
unknown session with 400 and keep the health endpoint available.

No prototype mutation or private-state access is involved: the input is an
ordinary HTTP header sent to the actual CLI. Other inherited names are a
related audit target; only `constructor` is claimed as reproduced here.
No production fix is included.

## Dead code and constrained coverage paths (not automatically bugs)

The following observations describe the current code and installed SDK. They
are not exclusions from the reported coverage and do not authorize changes to
production code. An unobserved guard is not automatically dead code.

### DC-001: final CLI transport alternative — proven redundant

`src/index.ts:148-158` exits unless exactly one of the three input flags is
true. They are immutable local booleans. At `src/index.ts:259`, the preceding
stdio and SSE alternatives are false, so `hasStreamableHttp` must be true.
The final invalid-input error at lines 275-277 cannot execute through the CLI.
Earlier validation already covers no-input and multiple-input cases.

### DC-002: stateless initialized-state branch — current lifecycle constraint

Each HTTP POST creates a fresh child, transport, and `isInitialized=false`.
The SDK parses the entire JSON body and synchronously delivers its messages
to `onmessage`; the child response that sets `isInitialized=true` arrives on a
later event-loop turn. Therefore the false side of `!isInitialized` at
`stdioToStatelessStreamableHttp.ts:210` is not reached by ordinary POST/batch
delivery. A later POST gets different state, not this initialized instance.
This depends on the installed SDK's delivery model; it is not a universal
protocol invariant.

### DC-003: stateless pending-message guard — internal invariant

`isAutoInitializing` is set true only after assigning `pendingOriginalMessage`.
When the message is cleared, the flag is reset in the same synchronous
callback. With ordinary non-reentrant logging, entering the auto-initialize
response block with a missing pending message at line 169 is unreachable.
Overwriting a pending message is still a real bug (GW-003), not proof that the
missing-message alternative can occur.

### DC-004: JSON request IDs — wire/schema constraint, not all checks redundant

For messages that survive SDK JSON-RPC validation, a present request ID is a
string or number. JSON cannot encode an own property with value `undefined`.
Thus independently falsifying `msg.id !== undefined` after `'id' in msg` at
stateless line 233 cannot be achieved with ordinary wire input.
Do not generalize this to the preceding ID-presence check: the SDK's
`isInitializeRequest` validates method/params, not the JSON-RPC ID itself.
Initialization-shaped notifications need separate analysis.

Update: `tests/statelessNotificationsE2e.test.ts` now covers that ID-absent
notification case. It verifies an empty 202 response and subsequent successful
requests, not that the notification is a valid MCP initialization handshake.

### DC-005: WebSocket health/cleanup — CLI reachability constraints

`stdioToWs.ts` sets readiness true before starting its HTTP listener and never
resets it. The not-ready health branch at line 105 is not available through a
listening CLI. `child.killed` is set during cleanup, followed synchronously by
process exit, so a normal health request cannot observe that state.
The child-absent cleanup branch at line 45 could matter if spawning throws
synchronously through the public function. An empty command is a realistic
configuration error that the CLI rejects before entering the gateway.
`tests/libraryConfiguration.test.ts` now covers this public-API startup failure
without accessing private state. The two health predicates remain constrained.

### DC-006: session-counter guard — non-reentrant public API invariant

An active entry starts at one. Decrementing to zero replaces it with a pending
timer entry; another decrement hits the pending-cleanup check first.
`sessionAccessCounter.ts:68` therefore cannot observe a nonpositive active
count through ordinary public operations. Reentrant logger callbacks or
private-state corruption are not representative tests of gateway behavior.

### DC-007: SDK-generated fields — contract-constrained, not globally dead

The SSE server transport constructs its session ID with `randomUUID()`;
`stdioToSse.ts:118` does not receive an absent ID from a normal client request.
Both reverse-bridge request wrappers normally see the SDK-generated initialize
request, including its method and protocol version. Falsifying those fields
requires a different lifecycle or contract, not merely malformed JSON input.
The wrapper checks are not classified as universally unreachable.

Update: `tests/bridgePipeliningE2e.test.ts` now demonstrates non-initialize
requests reaching the temporary wrappers during pipelined startup. Both the
SSE method check and HTTP initialize-schema check now have independence pairs.
Only the SSE wrapper's SDK-generated protocol-version field remains missing.

### Remaining guards still under investigation

The stateful timeout callback's missing-transport check, stateless
`!res.headersSent` error guard, and defensive primitive/missing-message error
normalization have no demonstrated ordinary CLI inputs for all alternatives.
They remain unclassified rather than being labeled dead based on coverage alone.

See `MCDC_REACHABILITY.md` for a complete inventory of the 27 remaining
conditions and what evidence would be required to cover them.
No production simplifications or safety-guard removals are included.
