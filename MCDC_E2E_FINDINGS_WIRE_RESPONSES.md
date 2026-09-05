# New gateway findings: upstream response preservation

2026-09-05, Node 24.18.0. Production remains unchanged. This supplements the
earlier findings documents; neither bug below is fixed in this PR.

## GW-011: an application result field crashes both reverse bridges

An upstream successful tool result may include extension fields. A result
containing `hasOwnProperty: "application-owned extension"` passes the installed
SDK's result schema, but both reverse bridges call that field as a function:

```text
TypeError: result.hasOwnProperty is not a function
```

The gateway exits without replying to the outstanding request. This is not
prototype mutation: the field is ordinary JSON application data supplied by an
HTTP/SSE peer. Expected: preserve the result and remain usable for later calls.

This is related to GW-002 but distinct: GW-002 misinterprets an `error` result
field; GW-011 lets a different result field shadow the method used to inspect
it and causes a process crash before the conditional decision completes.
Neither failing regression contributes to passing-suite MC/DC.

## GW-012: structured protocol error details are discarded

An upstream JSON-RPC error includes `code`, `message`, and `data`, for example:

```json
{
  "code": -32042,
  "message": "Invalid query",
  "data": {
    "field": "query",
    "retryable": false,
    "alternatives": ["a", "b"]
  }
}
```

Both reverse bridges preserve the code and message but omit `data` entirely.
The installed SDK accepts the envelope and keeps data on its `McpError`; the
gateway constructs a replacement error containing only code and message.
Expected: preserve the structured error details along with request correlation.

This is separate from GW-007's unproven malformed-thrown-value scenarios. The
input here is a valid protocol error, and both real transports reproduce the
loss. The test does not assert the lossy response as desired behavior.

## Reproduction and passing controls

`tests/bridgeWireResponsesE2e.test.ts` has four opt-in TODOs, one per bug and
transport, plus three passing robustness controls:

- Both event-stream transports ignore malformed frames and accept the following
  valid tool result; a subsequent valid protocol error preserves its code and
  message, and a later tool-list request succeeds. Exactly one reply per client
  request is required, with no malformed-frame payload leaked to stdout.
- The HTTP bridge converts malformed direct-JSON error envelopes into correlated
  error responses and remains usable for a later request.

The event frames include null, a null result, primitive errors, invalid code
types, missing messages, and a numeric message. Direct JSON covers null errors,
invalid code types, and missing messages. These cases do not turn raw wire
values into primitive exceptions: event validation ignores the bad frames, and
direct-JSON validation rejects with a normal SDK error object. They provide
additional evidence for the existing error-boundary reachability constraint,
not an E2E reproduction of GW-007.

```sh
nvm use 24
npm run build
RUN_KNOWN_BUG_TESTS=1 TS_NODE_TRANSPILE_ONLY=true node --test --experimental-loader ts-node/esm --experimental-test-module-mocks tests/bridgeWireResponsesE2e.test.ts
```

The focused opt-in run reproduced four failures with three passing controls.
Default TODO bodies do not execute and are excluded from passing-run evidence,
without changing the production coverage denominator.

`tests/helpers/wire-mcp-upstream.ts` is a local HTTP/SSE protocol peer. It writes
wire frames directly because an SDK server would validate its own output before
emitting deliberately malformed envelopes. It does not replace gateway methods,
client SDK methods, logger callbacks, or private state. Fixture failures are
reported separately in teardown instead of being mistaken for gateway behavior.
