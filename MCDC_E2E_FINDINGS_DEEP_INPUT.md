# New gateway finding: deeply nested HTTP input

2026-09-05. Production code is unchanged. This finding supplements
`MCDC_E2E_FINDINGS.md`; it is not a fix proposal implemented in this PR.

## GW-009: deeply nested requests leave the HTTP exchange open

Affected: stateless Streamable HTTP, Node 24.18.0 and the installed SDK.

A JSON-RPC `tools/list` request with an extra parameter containing 20,000
nested arrays fits below the HTTP body-size limit (about 40 KB). The request
never completes within the test's five-second deadline. The gateway reports
`ERR_HTTP_HEADERS_SENT` from the SDK's error-response path; an independent
health request still returns 200. This is a hung request, not an observed
process crash. Two focused runs reproduced it.

Code-path analysis: the gateway serializes the incoming message inside its
transport message callback. Deep input can exceed the JavaScript serializer's
stack limit. The SDK has already prepared response headers before invoking
that callback and tries to write a second set when handling the exception.
The gateway's outer catch logs the escaping header error but does not finish
the existing response. The observed terminal error is the header exception;
the preceding serialization failure is inferred from this code path. A separate
Node 24 check confirms that parsing this nesting succeeds but serializing it
throws `RangeError: Maximum call stack size exceeded`.

Expected: accept and correctly answer the request, or reject excessive nesting
with a bounded client error. Do not leave the exchange hanging. The test does
not require unlimited nesting support or prescribe an implementation fix.

`tests/httpDeepInputE2e.test.ts` retains this expectation as an opt-in TODO:

```sh
nvm use 24
npm run build
RUN_KNOWN_BUG_TESTS=1 TS_NODE_TRANSPILE_ONLY=true node --test --experimental-loader ts-node/esm --experimental-test-module-mocks tests/httpDeepInputE2e.test.ts
```

That command currently reports one pass and one expected regression failure.
The failing request is not included in passing-suite coverage.

## Passing companion: malformed notification containment

The same file sends a deeply nested malformed progress notification without a
request ID. It checks that the HTTP exchange completes, the health endpoint
works, and a later tool request succeeds. The assertion permits either normal
notification acceptance or a client-error rejection; it does not require the
notification to be forwarded or treat unlimited nesting as supported.

The input is ordinary HTTP wire text. No gateway internals, logger callbacks,
SDK methods, or runtime stack settings are replaced.
