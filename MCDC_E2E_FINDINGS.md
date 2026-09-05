# Findings from the end-to-end MC/DC audit

2026-09-05, Node 24.18.0. These are Supergateway findings, not SuperCov bugs.
No production source changes were made in this test-expansion batch.

## Confirmed: fallback initialization crashes both upstream-to-stdio bridges

Affected source:

- `src/gateways/sseToStdio.ts`: fallback branch at line 149; response construction at line 182.
- `src/gateways/streamableHttpToStdio.ts`: fallback branch at line 148; response construction at line 183.

When the first incoming stdio request is `tools/list` instead of `initialize`,
both bridges enter their explicit fallback-client initialization path. The
upstream connection succeeds, but the original request is never forwarded and
`result` remains undefined. The process then exits with:

```text
TypeError: Cannot read properties of undefined (reading 'hasOwnProperty')
```

Reproduce without SuperCov, from the repository root on Node 24:

```sh
npm run build
node tests/helpers/reproduce-bridge-fallback.mjs
```

The reproducer starts real upstream and bridge CLI processes, sends an actual
JSON-RPC request over stdin, and expects a tools-list response. Both cases fail
against current production code. It is deliberately outside the default
`*.test.ts` test glob so the passing coverage baseline does not include these
failing executions. It should become a regular end-to-end regression test when
the bug is fixed, not a permanent exception.

Normal MCP clients initialize first. This finding concerns the fallback
behavior that these gateway functions explicitly attempt to implement, not a
claim that uninitialized requests are required by the MCP protocol.

Suggested fix: after creating/connecting the fallback client, forward the
original request and assign its result inside the existing error-handling
boundary. Test both success and remote error handling. Not implemented here.

## Code-level defect: configured headers are logged as absent

The SSE, stateful HTTP, and stateless HTTP server gateways use
`Object(headers).length` when choosing whether to log headers. A normal header
object has no `length`, so this stays false even for nonempty configured
headers. The E2E tests verify that the actual response headers are delivered;
the problem is the startup diagnostic.

Locations: `stdioToSse.ts:50`, `stdioToStatefulStreamableHttp.ts:52`,
`stdioToStatelessStreamableHttp.ts:81`.

Use `Object.keys(headers).length` consistently with the reverse gateways.
Do not add an artificial HTTP header named `length` just to cover the other
side of this condition. No fix made in this batch.

## Constraints relevant to pursuing 100% MC/DC

These are source/SDK observations, not a blanket claim that every remaining
gap is unreachable:

- The CLI's final `hasStreamableHttp` false branch follows validation that
  exactly one input transport is selected and the other two are false.
- Several initialization checks are downstream of SDK schema validation.
  Independently falsifying every subcondition may require bypassing that
  validation, which would not be an end-to-end test.
- Both reverse gateways handle errors defensively as potentially null,
  primitive, or missing a message. Real tested SDK/network failures are Error
  objects. Producing arbitrary thrown primitives would require lower-level
  fault injection, not ordinary JSON-RPC error responses.
- `SessionAccessCounter`'s nonpositive-active-count guard cannot be reached
  by normal public increments/decrements: reaching zero replaces the active
  entry with a pending timer. The gateway always calls `clear` with
  `runCleanup=false`; its true branch is available only through the counter's
  public API, not the current CLI.
- WebSocket health routes become reachable only after `isReady=true` and the
  HTTP listener starts. The not-ready response is therefore not naturally
  testable through an already-listening CLI.
- WebSocket/SSE transport setup relies on SDK-generated handlers/session IDs;
  absent-handler or absent-generated-ID cases may need focused public
  transport tests rather than CLI-only tests.

No exclusions, private-state mutation, production-code rewrites, or failed-run
merging were used to improve the reported MC/DC percentage.
