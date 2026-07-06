# fix(stateless): reap per-request child session on response end + survive client disconnect

Closes #108. Closes #143.

Two related reliability bugs in `stdioToStatelessStreamableHttp`, both in the per-request
child-process lifecycle. Fixed together because they touch the same POST handler.

## #108 — child processes never reaped (unbounded memory growth)

In stateless mode a stdio child is spawned per request. It was only cleaned up via
`child.on('exit')` (a long-lived MCP stdio server never self-exits) and `transport.onclose`
(does not fire after a one-shot stateless response). The stateful gateway already reaps on
`res.on('finish'|'close')`; the stateless one did not — so children accumulated until OOM.

Fix: spawn the child `detached` (its own process group) and reap on response end. `{ shell:
true }` runs the server as a grandchild under `/bin/sh`, so a plain `child.kill()` orphans it.
We `SIGTERM` the request's process group, then after a grace window
(`SUPERGATEWAY_REAP_GRACE_MS`, default 2000) `SIGKILL` **only the processes still in this
request's own session** — anything that deliberately detached (called `setsid`, was handed to a
supervisor such as `systemd-run`, or double-forked and re-parented to init) is spared, so
intentionally long-lived work started during a request is not killed as collateral. The grace
window also gives a job the chance to detach itself and survive.

## #143 — client disconnect crashes the whole gateway

The child's stdout handler called the async `transport.send()` un-awaited and without
`.catch()`, inside a synchronous `try/catch` (which cannot catch an async rejection). If the
client already disconnected, `send()` rejects with `No connection established for request ID`,
producing an unhandled rejection that terminates the process (Node default since v15) — taking
every other in-flight request down with it.

Fix: `Promise.resolve(transport.send(jsonMsg)).catch(...)` so a gone-away client is logged, not
fatal. (The stateful/stdio variants have the same pattern — see #142/#144 — out of scope here.)

## Tests

Three regression tests (`tests/statelessChildReap.test.ts`, `tests/statelessDisconnect.test.ts`,
`tests/statelessDetachedSurvives.test.ts`):

- reap: after 12 connect→callTool→close cycles, residual child count returns to baseline
  (process inspection is Linux-gated).
- disconnect: after 8 aborted mid-flight requests the gateway still serves a clean `callTool`.
- detached-survives: a child that `setsid`-detaches during a request outlives the reap while an
  in-session sibling is reaped — proving the SIGKILL sweep is scoped to the request's own session.

Full suite green (11/11). Benchmark: over 200 sequential stateless inits, child count stays
flat (was linear growth).

## Prior art

This consolidates the intent of #103 / #111 / #148 (leak) and #122 / #135 / #144 (rejection),
adding the regression tests none of those carried. Related: #137 (shell group-kill), #141
(stateful sibling of the leak). A minor extra: if the child exits before any response headers
are sent, a 502 is returned instead of hanging — a partial step toward #139 (the full #139 fix,
emitting an error onto an already-open stream, is left for a follow-up).
