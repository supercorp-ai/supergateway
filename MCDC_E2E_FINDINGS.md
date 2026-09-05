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
RUN_KNOWN_BUG_TESTS=1 TS_NODE_TRANSPILE_ONLY=true node --test --test-concurrency=1 --experimental-loader ts-node/esm --experimental-test-module-mocks tests/bridgeFallbackE2e.test.ts tests/bridgeResultE2e.test.ts tests/statelessBatchE2e.test.ts tests/headerDiagnosticsE2e.test.ts
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

## GW-004: rejected stateless transport sends can crash the process

Affected: `stdioToStatelessStreamableHttp.ts`.

`transport.send(jsonMsg)` returns a promise, but only synchronous exceptions
are caught. An unsolicited stale response ID can cause an unhandled rejection.

The interleaving/stale-reply TODO in `tests/statelessBatchE2e.test.ts` expects
the error to be reported without stopping subsequent requests. This crash also
occurred during the GW-003 batch reproduction.

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

## Coverage constraints, not bug reports

Some remaining conditions are unreachable or constrained by validation. For
example, after validating exactly one CLI input transport, ruling out stdio and
SSE guarantees HTTP. SDK-generated IDs and lifecycle invariants constrain other
checks. These observations do not authorize deleting checks: no production
simplifications or safety-guard removals are included.
