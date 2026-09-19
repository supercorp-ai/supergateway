# Changelog

## 4.0.0-rc.4

- Answer 404 rather than 400 when a request carries a session id the gateway no longer holds, so a client whose session has expired or been ended starts a new one instead of failing every later call.

## 4.0.0-rc.3

- Deliver a stateful server's progress notifications on the call they belong to, so the first one is no longer lost when a client has not yet opened its event stream.

## 4.0.0-rc.2

- Deliver a client's notifications and replies to the server instead of returning them to the client.
- Expire an idle stateful session after 30 minutes, so a client that disconnects without ending its session no longer strands the server process it was using.

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
