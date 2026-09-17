# Changelog

## Unreleased

### Improvements and fixes

- Keep concurrent interactive operations isolated and support explicit continuation retries after completion.

- Keep the stdio server running between rounds of an MCP 2026-07-28 operation that asks the client for input, so state the server signed still verifies when the client continues.

### Breaking changes

- Requires Node.js 20 or newer.

### Improvements and fixes

- Support newer MCP protocols while preserving compatibility with older servers.
- Improve SSE reconnection, HTTP session handling, and subprocess cleanup.
- Preserve Unicode text split across subprocess output chunks.
- Improve error handling and redact credentials from diagnostic logs.
- Report the correct version with `--version`.
- Fix the Deno container and install the requested Supergateway version in images.
- Exclude tests and development files from npm packages.
