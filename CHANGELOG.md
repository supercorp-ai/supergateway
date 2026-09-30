# Changelog

## 4.1.0

No breaking changes to flags or protocol, and no new flags. Upgrading from 4.0.0:

### Behaviour change

- Each SSE and WebSocket connection now gets its own server process, as stateful Streamable HTTP sessions already did. Clients no longer share server state or see each other's replies, notifications or requests. A client that reconnects gets a fresh server, so in-memory server state does not survive a reconnect, and the gateway runs one server per live connection. Deployments that relied on every client sharing one server should review this before upgrading.

### Improvements and fixes

- Relay server-initiated requests (sampling, roots, elicitation), notifications, cancellation and string request ids through WebSocket and the `--sse` and `--streamableHttp` bridges, and stop cutting bridged calls off after 60 seconds.
- Stop reading a server's output while its client is not reading, instead of holding it all in memory. One slow client can no longer exhaust the gateway's memory and take every other client down with it.
- A malformed or oversized POST to an SSE session is answered with an error and no longer ends that session.
- Escape U+2028 and U+2029 in SSE JSON, so clients that split on Unicode line separators no longer cut a message in two.
- With `--sessionTimeout`, ping idle stateful event streams, so a session whose client vanished behind a proxy that keeps the stream open is still ended.
- Fail an SSE client's in-flight calls as soon as its server process exits, instead of leaving them to time out.
- Close a cancelled call's stream in stateful Streamable HTTP, instead of holding a connection open until the session ends.
- Keep idle HTTP connections for 65 seconds, longer than common load balancers keep theirs, to avoid intermittent connection resets and 502s.
- End the upstream session when a `--streamableHttp` bridge exits, and reconnect a bridge after its upstream restarts.
- Report an SSE upstream that never sends its endpoint event, instead of hanging.
- Stateless Streamable HTTP: accept JSON-RPC batches, start each server with the client's protocol version, and deliver `notifications/initialized` once.
- Accept request bodies up to 4 MB in the Streamable HTTP modes, as SSE already did, and answer a rejected body with a JSON-RPC error instead of an HTML page.
- Apply `--header` to every HTTP response, accept a `--sessionTimeout` of up to 30 days, and refuse a non-numeric one.
- Route path flags given without a leading slash, and handle a `--baseUrl` that ends in a slash.
- Refuse credentials in an upstream URL, with guidance to send them with `--header` instead, and never print them.
- Read large server output and large upstream events in linear time.

## 4.1.0-rc.0

### Improvements and fixes

- Give each WebSocket connection its own server process, as SSE connections now have: clients no longer receive each other's notifications or requests.
- Relay server-initiated requests (sampling, roots, elicitation), notifications, cancellation and string request ids through WebSocket and the `--sse` and `--streamableHttp` bridges, and stop cutting bridged calls off after 60 seconds.
- Stop reading a server's output while its client is not reading, instead of holding it all in memory. One slow client can no longer exhaust the gateway's memory and take every other client down with it.
- Fail an SSE client's in-flight calls as soon as its server process exits, instead of leaving them to time out.
- Close a cancelled call's stream in stateful Streamable HTTP, instead of holding a connection open until the session ends.
- Keep idle HTTP connections for 65 seconds, longer than common load balancers keep theirs, to avoid intermittent connection resets and 502s.
- End the upstream session when a `--streamableHttp` bridge exits, and reconnect a bridge after its upstream restarts.
- Report an SSE upstream that never sends its endpoint event, instead of hanging.
- Stateless Streamable HTTP: accept JSON-RPC batches, start each server with the client's protocol version, and deliver `notifications/initialized` once.
- Accept request bodies up to 4 MB in the Streamable HTTP modes, as SSE already did, and answer a rejected body with a JSON-RPC error instead of an HTML page.
- Apply `--header` to every HTTP response, accept a `--sessionTimeout` of up to 30 days, and refuse a non-numeric one.
- Route path flags given without a leading slash, and handle a `--baseUrl` that ends in a slash.
- Refuse credentials in an upstream URL, with guidance to send them with `--header` instead, and never print them.
- Read large server output and large upstream events in linear time.

## 4.0.0

### Breaking changes

- Requires Node.js 20 or newer.
- Stateful stdio→Streamable HTTP sessions now expire after 30 minutes of idleness. Previously an unconfigured session never expired, which stranded the server process of any client that disconnected without ending its session. Pass a large `--sessionTimeout` if you relied on the old behaviour.

### Improvements and fixes

- Support newer MCP protocols while preserving compatibility with older servers.
- Deliver a client's notifications and replies to the server instead of returning them to the client.
- Deliver a stateful server's progress notifications on the call they belong to, so the first one is no longer lost when a client has not yet opened its event stream.
- Answer 404 rather than 400 when a request carries a session id the gateway no longer holds, so a client whose session has expired or been ended starts a new one instead of failing every later call.
- Keep interactive operations isolated when servers return identical continuation state, and preserve signed multi-round operations and explicit continuation retries after completion.
- Improve SSE reconnection, HTTP session handling, and subprocess cleanup.
- Preserve Unicode text split across subprocess output chunks.
- Improve error handling and redact credentials from diagnostic logs.
- Report the correct version with `--version`.
- Fix the Deno container and install the requested Supergateway version in images.
- Exclude tests and development files from npm packages.

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
