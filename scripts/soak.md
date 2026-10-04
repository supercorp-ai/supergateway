# Release candidate soak

Use the exact published `4.2.0-rc.0` tarball and its verified SHA-256 from the
npm publication workflow. The installer rejects an absent or mismatched digest;
it does not follow the moving `next` tag. Installation keeps normal npm dependency
resolution and archives the resolved production lockfile.

The **Published release soak** workflow is manual. Select `canary` first.
Only select `five-hours` or `twenty-five-hours` after reviewing the canary
results and receiving approval for the long run. `five-hours` is one phase; the
25-hour campaign is five of them, one after another. A push does not start this
workflow.

A failure costs only what failed. Within a phase, a failed command is recorded
and everything else runs on to the phase's deadline; a failed lane does not
cancel the other lanes; and each phase runs after the one before it whether or
not that one passed, as long as the canary did. The `verdict` job fails the
campaign if any phase failed and names them: rerun only the failed lanes with
`gh run rerun <run id> --failed`.

## Workload

- Linux, macOS and Windows on Node 20, 22, 24 and 26 (12 lanes).
- Each lane checks native process enumeration, then tests real continuation
  expiry, capacity eviction and backend crashes against the installed CLI.
- Repeated protocol checks include signed continuation rounds, repeated backend
  tokens, explicit retries, cancellation and concurrent-client isolation.
- Since 4.0.0 they also cover what the bridges relay from the upstream server
  (notifications, sampling, roots, elicitation) and cancel, one child per
  WebSocket connection, resources and prompts, and the stateless handshake.
- POSIX lanes also exercise legacy transports, shutdown and SDK 1.30/1.4 clients.
- POSIX resource tests keep six gateways alive: SSE, WebSocket, legacy stateful
  and stateless HTTP, modern HTTP, and modern signed continuations. They check
  call results, reconnects, cancellation, Unicode and sustained continuation
  churn. One legacy stateful session stays open throughout active load.
- POSIX lanes also run six real MCP servers, pinned from npm and PyPI
  (`scripts/real-servers/servers.ts`), through every gateway path each cycle,
  and require the same answers as a direct stdio connection. The MCP
  Inspector's CLI does the same against server-everything
  (`scripts/inspectorClient.test.ts`), including as the stdio client of both
  bridges. The workflow runs both once before the clock starts, so a registry
  outage fails fast.
- POSIX lanes also run sustained scenarios (`scripts/soak-scenarios.test.ts`):
  long-lived SSE and Streamable HTTP bridges relaying logs, progress and
  sampling, cancelling calls, carrying 4 MB replies and surviving upstream
  restarts; busy and idle WebSocket clients side by side; and servers crashing
  mid-call in every mode. They have their own child, descriptor and RSS gates.
- A separate Ubuntu job runs the Python and Go SDK and Ruby client batteries
  (`tests/clients/`) over every output transport for the whole phase
  (`scripts/soak-languages.mjs`).
- Windows runs the portable protocol and continuation checks, including fixture
  child cleanup. It does not claim the POSIX RSS, descriptor or process-group tests.

The canary uses 60 seconds of active load, **plus** the finite five-minute
continuation test and cleanup. It usually takes more than ten minutes. Each long
phase is five hours of load on fresh runners and fresh processes, so the longest
gateway lifetime the hosted soak checks is five hours: a GitHub-hosted job runs
at most six (https://docs.github.com/en/actions/reference/limits), and nothing
outlives its job. The 25-hour campaign is not one uninterrupted 25-hour gateway
lifetime.

For an uninterrupted local six-hour run, install the same public artifact using
`scripts/install-soak-artifact.mjs`, then run `scripts/overnight-release.mjs` with
`SOAK_SECONDS=21600`. Set `SUPERGATEWAY_TEST_ENTRY` to the generated `entry.txt`
path, `SOAK_PACKAGE_VERSION=4.2.0-rc.0`, the verified `SOAK_PACKAGE_SHA256`, and
`SUPERGATEWAY_SOAK_CONFIRMED=1`. Use Node 24 for the macOS memory follow-up.

The original five resource modes retain their 30-second cooldown and existing
RSS/descriptor/child gates. Continuations have a separate five-minute idle
retention window, after which all their children must be gone. No forced garbage
collection or relaxed memory threshold is used. A short canary does not clear
the earlier hosted macOS Node 24 memory failure.

Failures, skips and TODOs stay visible; there is no automatic retry. Review the
uploaded summaries, resource time series, artifact identity and dependency locks
before deciding whether the candidate is ready for stable publication. All
workloads use local fixtures, without paid API traffic.
