# New gateway finding: idle-timeout range

2026-09-05. Tests and documentation only; production remains unchanged.

## GW-010: large accepted idle timeouts expire sessions immediately

The stateful HTTP CLI accepts `--sessionTimeout 2592000000` (30 days in
milliseconds). After initialization, Node reports:

```text
TimeoutOverflowWarning: 2592000000 does not fit into a 32-bit signed integer.
Timeout duration was set to 1.
```

The session expires and its MCP child receives SIGTERM. A tool-list request
after a 100 ms pause receives HTTP 400 for the previously valid session.
The one-day control case retains the session and returns the expected tools.

The CLI validates only that a numeric timeout is positive. The session counter
passes it directly to `setTimeout`, so this accepted value has the opposite
effect from the requested long idle period. This is not evidence of a missing
transport in the cleanup callback: cleanup finds and closes a real session.

Expected: honor an accepted timeout. Alternatively, reject unsupported values
clearly at startup rather than silently running with a drastically shorter
timeout. The retained TODO describes the honor-the-value behavior; a future
decision to impose a documented maximum should update the regression to check
explicit rejection. No fix or configuration-policy change is made here.

## Reproduction

`tests/sessionTimeoutRangeE2e.test.ts` contains the passing one-day control and
the opt-in 30-day regression:

```sh
nvm use 24
npm run build
RUN_KNOWN_BUG_TESTS=1 TS_NODE_TRANSPILE_ONLY=true node --test --experimental-loader ts-node/esm --experimental-test-module-mocks tests/sessionTimeoutRangeE2e.test.ts
```

The focused reproduction on Node 24.18.0 reports one pass and one failure.
The failing TODO body is not executed in the default coverage run.

## Related passing lifecycle check

`tests/sessionTerminationE2e.test.ts` deletes a session with both an open SSE
event stream and a pending tool call. It verifies that both exchanges settle
without hitting client timeouts, the MCP child disconnects without releasing
the tool from the test, no old-session idle cleanup runs after the configured
deadline, the deleted session is rejected, and a fresh session initializes.

This uses actual HTTP DELETE, sockets, child processes, and timers. No SDK
method replacement, private-state mutation, or reentrant logger is involved.
