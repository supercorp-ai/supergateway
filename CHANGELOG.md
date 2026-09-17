# Changelog

## 4.0.0 — release candidate

### Compatibility

- Requires Node.js 20 or newer. Installing Supergateway does not upgrade Node.
  Node 18 users should upgrade Node before upgrading Supergateway. Existing
  installations can remain pinned with `npx -y supergateway@3.4.3` while migrating.
- Supports MCP 2026-07-28 over stdio → Streamable HTTP when both peers support
  that protocol. Automatic clients can fall back to a legacy server. Supergateway
  preserves the wrapped server's protocol semantics; it cannot make peers with
  no common protocol compatible.
- Defaults stay the same: stdio input uses SSE output unless selected otherwise;
  Streamable HTTP uses stateless mode unless `--stateful` is supplied. Modern
  MCP requests do not create legacy transport sessions.
- Container images use Node.js 24. Commands that run Node-based MCP servers
  inside those images should be checked against Node 24 before upgrading.

### Fixes

- Unicode text stays intact when a child splits a UTF-8 character across stdout writes.
- SSE clients can reconnect without the previous transport-connection crash.
- Completed stateless HTTP requests release their subprocesses. Stateful
  sessions remain usable between requests and after a stream disconnect.
- Child exits and I/O failures settle unfinished HTTP requests and leave other
  sessions usable.
- Gateway shutdown reaps owned child processes and their descendants on POSIX.
  A child that ignores termination can extend shutdown by up to five seconds.
- Stateless HTTP delivers request-associated notifications and rejects
  unsupported server-to-client requests without hanging.
- Credential headers are redacted from diagnostic logs while configured headers
  continue to reach their destinations.
- Reverse bridges preserve successful results containing error-named fields and
  upstream error details. HTTP failures produce valid JSON-RPC error codes.
- Invalid request envelopes receive invalid-request errors. Rejected protocol
  headers or duplicate SSE streams no longer destroy an established HTTP session.
- Container variants install the tested package. The Deno image includes a
  working Deno runtime; base and uvx variants are tested on AMD64 and ARM64 too.

### Packaging

- npm packages include compiled code, package metadata, the dependency
  shrinkwrap, README and license. Development tests and tooling are excluded.
- The declared dependency tree is pinned by the shipped shrinkwrap.

### Usage notes

- SSE and WebSocket clients share one backend process. Use them within the same
  trust boundary; separate reply routing does not isolate backend application state.
- npm may reuse a cached version for bare `npx supergateway`, depending on its
  version. `npx -y supergateway@latest` explicitly requests the latest release;
  an exact version is appropriate for reproducible client configurations.
- Modern protocol compatibility has dedicated tests. Verification of the
  specific Claude.ai/backend setup reported in #156 remains pending.
