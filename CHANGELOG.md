# Changelog

## 4.0.0-rc.1

- Keep interactive operations isolated when servers return identical continuation state.
- Preserve signed multi-round operations and explicit continuation retries after completion.

## 4.0.0-rc.0

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
