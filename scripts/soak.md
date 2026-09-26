# RC.1 soak

Use the exact published `4.0.0-rc.1` tarball and its verified SHA-256 from the
npm publication workflow. The installer rejects an absent or mismatched digest;
it does not follow the moving `next` tag. Installation keeps normal npm dependency
resolution and archives the resolved production lockfile.

The **Published release soak** workflow is manual. Select `canary` first.
Only select `six-hours` after reviewing the canary results and receiving approval
for the long run. A push does not start this workflow.

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
- Windows runs the portable protocol and continuation checks, including fixture
  child cleanup. It does not claim the POSIX RSS, descriptor or process-group tests.

The canary uses 60 seconds of active load, **plus** the finite five-minute
continuation test and cleanup. It usually takes more than ten minutes. The long
workflow runs two sequential three-hour phases per lane, each starting fresh
processes. It is not one uninterrupted six-hour gateway lifetime.

For an uninterrupted local six-hour run, install the same public artifact using
`scripts/install-soak-artifact.mjs`, then run `scripts/overnight-release.mjs` with
`SOAK_SECONDS=21600`. Set `SUPERGATEWAY_TEST_ENTRY` to the generated `entry.txt`
path, `SOAK_PACKAGE_VERSION=4.0.0-rc.1`, the verified `SOAK_PACKAGE_SHA256`, and
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
