![Supergateway: Run stdio MCP servers over SSE and WS](https://raw.githubusercontent.com/supercorp-ai/supergateway/main/supergateway.png)

**Supergateway** runs **MCP stdio-based servers** over **SSE (Server-Sent Events)** or **WebSockets (WS)** with one command. This is useful for remote access, debugging, or connecting to clients when your MCP server only supports stdio.

Questions, ideas or just want to chat? Join the community on [Discord](https://discord.gg/CudcAH53yF).

Supported by:

- [Supercov](https://supercov.com) — Coverage for coding agents and software factories 🌙
- [Superinterface](https://superinterface.ai)
- [Supercorp](https://supercorp.ai)

## Installation & Usage

Run Supergateway via `npx`:

```bash
npx -y supergateway --stdio "uvx mcp-server-git"
```

- **`--stdio "command"`**: Command that runs an MCP server over stdio
- **`--sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"`**: SSE URL to connect to (SSE→stdio mode)
- **`--streamableHttp "https://mcp-server.example.com/mcp"`**: Streamable HTTP URL to connect to (StreamableHttp→stdio mode)
- **`--outputTransport stdio | sse | ws | streamableHttp`**: Output MCP transport (default: `sse` with `--stdio`, `stdio` with `--sse` or `--streamableHttp`). A remote server given with `--sse` or `--streamableHttp` can be served over `sse`, `ws` or `streamableHttp` too; see [Remote server → SSE, WS or Streamable HTTP](#remote-server--sse-ws-or-streamable-http)
- **`--port 8000`**: Port to listen on (stdio→SSE, stdio→WS or stdio→Streamable HTTP mode, default: `8000`)
- **`--host 127.0.0.1`**: Address to listen on, e.g. `127.0.0.1` or `::1` (`[::1]` also works) (stdio→SSE, stdio→WS or stdio→Streamable HTTP mode, default: every interface). `--baseUrl` does not control binding: only `--host` limits which addresses accept connections. Refused in SSE→stdio and Streamable HTTP→stdio mode, which listen on nothing
- **`--baseUrl "http://localhost:8000"`**: Base URL for SSE clients (stdio→SSE mode; optional)
- **`--ssePath "/sse"`**: Path for SSE subscriptions (stdio→SSE mode, default: `/sse`)
- **`--messagePath "/message"`**: Path for messages (stdio→SSE or stdio→WS mode, default: `/message`)
- **`--streamableHttpPath "/mcp"`**: Path for Streamable HTTP (stdio→Streamable HTTP mode, default: `/mcp`)
- **`--stateful`**: Run stdio→Streamable HTTP in stateful mode
- **`--sessionTimeout 60000`**: Session timeout in milliseconds (stateful stdio→Streamable HTTP mode only)
- **`--protocolVersion "2025-06-18"`**: Protocol version the gateway uses when it initializes the server itself and the client's request doesn't name one (stateless stdio→Streamable HTTP mode, default: `2024-11-05`)
- **`--header "x-user-id: 123"`**: Add one or more headers (stdio→SSE, stdio→Streamable HTTP, SSE→stdio, or Streamable HTTP→stdio mode; can be used multiple times). With a local server they go on the gateway's responses; with a remote one (`--sse`, `--streamableHttp`) they are sent to the remote server
- **`--oauth2Bearer "some-access-token"`**: Adds an `Authorization` header with the provided Bearer token
- **`--logLevel debug | info | none`**: Controls logging level (default: `info`). Use `debug` for more verbose logs, `none` to suppress all logs.
- **`--logFormat text | json`**: Log line format (default: `text`). `json` writes one JSON object per line with `time`, `level`, `msg` and, when a log call carries values, `data`, for ELK and similar log pipelines. Logs go to the same streams as `text`, so stdio output still carries only MCP messages.
- **`--cors`**: Enable CORS (stdio→SSE or stdio→WS mode). Use `--cors` with no values to allow all origins, or supply one or more allowed origins (e.g. `--cors "http://example.com"` or `--cors "/example\\.com$/"` for regex matching).
- **`--healthEndpoint /healthz`**: Register one or more endpoints (every mode but stdio output; can be used multiple times) that respond with `"ok"`
- **`--healthCheck gateway | server`**: What the health endpoints check (default: `gateway`). `gateway` answers `"ok"` while the gateway is up. `server` also checks the MCP server: it starts one (or, for `--sse`/`--streamableHttp`, opens a session with the remote server), initializes and pings it, and stops it. It answers `"ok"` if the server responded within 10 seconds, and `503` with the reason otherwise (e.g. `unhealthy: the server exited (code=1, signal=null)`). The answer is reused for 10 seconds, so polling every second starts at most one server per 10 seconds. The startup log says when health turns bad and when it recovers
- **`--toolPrefix "github_"`**: Put this before every tool name the server lists, so `search` becomes `github_search` (all modes). Clients call the tool by that name, and the server still gets its own. It is used as given, so include a separator. Tool names may be letters, digits, `_`, `-` and `.`, at most 128 characters; the gateway warns about a prefix or name outside that
- **`--tools search --tools get_issue`**: Expose only these tools, by the server's own names (all modes). The others are left out of `tools/list`, and a call to one is refused with `-32602 Unknown tool`, as a server refuses a tool it doesn't have, without reaching the server. A bare `--tools` exposes none
- **`--apiKey "some-key"`**: Require clients to present this key, as `Authorization: Bearer <key>` or `X-API-Key: <key>` (stdio→SSE, stdio→WS or stdio→Streamable HTTP mode; can be used multiple times). Also `SUPERGATEWAY_API_KEY=some-key`. See [Requiring an API key](#requiring-an-api-key)
- **`--apiKeyFile /run/secrets/keys`**: Accept the keys in this file, one per line (blank lines are skipped). Also `SUPERGATEWAY_API_KEY_FILE=/run/secrets/keys`
- **`--exitWithProcess <pid>`**: Shut down, stopping the MCP server, when process `<pid>` exits (all modes). Pass the launcher's PID (e.g. `$$`); it need not be the direct parent, so it works through `npx`. Checked about once a second. A launcher that spawns Supergateway with a stdin pipe doesn't need this: since 4.0 Supergateway exits when its stdin closes.
- **`--config servers.json`**: Read servers and settings from a config file instead of the server flags. See [Several servers from a config file](#several-servers-from-a-config-file)
- **`--checkConfig`**: With `--config`, check the file, list each server's path and output, and exit
- **`--printConfig`**: Print the resolved config, secrets redacted, and exit. Without `--config` it prints the file equivalent to the command line given

## stdio → SSE

Expose an MCP stdio server as an SSE server:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --ssePath /sse --messagePath /message
```

- **Subscribe to events**: `GET http://localhost:8000/sse`
- **Send messages**: `POST http://localhost:8000/message`
- Each SSE connection gets its own server process.

## SSE → stdio

Connect to a remote SSE server and expose locally via stdio:

```bash
npx -y supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
```

Useful for integrating remote SSE MCP servers into local command-line environments.

You can also pass headers when sending requests. This is useful for authentication:

```bash
npx -y supergateway \
    --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app" \
    --oauth2Bearer "some-access-token" \
    --header "X-My-Header: another-header-value"
```

## Streamable HTTP → stdio

Connect to a remote Streamable HTTP server and expose locally via stdio:

```bash
npx -y supergateway --streamableHttp "https://mcp-server.example.com/mcp"
```

This mode is useful for connecting to MCP servers that use the newer Streamable HTTP transport protocol. Like SSE mode, you can also pass headers for authentication:

```bash
npx -y supergateway \
    --streamableHttp "https://mcp-server.example.com/mcp" \
    --oauth2Bearer "some-access-token" \
    --header "X-My-Header: another-header-value"
```

## stdio → Streamable HTTP

Expose an MCP stdio server as a Streamable HTTP server.

Supports legacy MCP and **2026-07-28** when the client and stdio server support a common protocol version. Clients that support automatic negotiation can fall back to legacy when the server requires it.

`--stateful` preserves legacy sessions. MCP 2026-07-28 uses independent requests and does not create a transport session.

Interactive MCP 2026-07-28 operations can continue across requests. Continuations and explicit retries are available for up to five minutes of inactivity, with at most 64 saved continuation states. Older states may expire sooner when this limit is reached.

### Stateless mode

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport streamableHttp \
    --port 8000
```

### Stateful mode

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport streamableHttp --stateful \
    --sessionTimeout 60000 --port 8000
```

The Streamable HTTP endpoint defaults to `http://localhost:8000/mcp` (configurable via `--streamableHttpPath`).

## stdio → WS

Expose an MCP stdio server as a WebSocket server:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --outputTransport ws --messagePath /message
```

- **WebSocket endpoint**: `ws://localhost:8000/message`
- Each WebSocket connection gets its own server process.

## Remote server → SSE, WS or Streamable HTTP

Serve a remote MCP server to clients that need another transport, or behind your own API key:

```bash
npx -y supergateway \
    --streamableHttp "https://mcp.example.com/mcp" \
    --oauth2Bearer "$UPSTREAM_TOKEN" \
    --outputTransport streamableHttp --stateful --apiKey "$MCP_API_KEY"
```

- Each client session gets its own session with the remote server, ended when the client's ends, and at shutdown.
- `--header` and `--oauth2Bearer` go to the remote server. The client's own `Authorization` and API key never do.
- Requests from the remote server to the client (sampling, roots, elicitation) are passed through.
- A remote server that is down, refuses the client or goes away fails that session only.
- The 2026-07-28 protocol's stateless requests are served only for local servers so far.

## Requiring an API key

By default anyone who can reach the port can use the server. With `--apiKey`, every request to stdio→SSE, stdio→WS or stdio→Streamable HTTP must carry a key:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --outputTransport streamableHttp --apiKey "$MCP_API_KEY"

curl -H "Authorization: Bearer $MCP_API_KEY" ...   # or: -H "X-API-Key: $MCP_API_KEY"
```

- A request without a valid key gets `401 Unauthorized`. The `--healthEndpoint` paths and, with `--cors`, browser preflight requests stay open.
- Keys from `--apiKey`, `--apiKeyFile`, `SUPERGATEWAY_API_KEY` and `SUPERGATEWAY_API_KEY_FILE` are all accepted together, so a key can be rotated by adding the new one before removing the old.
- An empty key, an unreadable key file or one with no keys stops the gateway at startup rather than running it without authentication.
- Keys are never logged. Use HTTPS (e.g. behind a reverse proxy) so they are not sent in clear text.
- To send a key to a remote server from SSE→stdio or Streamable HTTP→stdio, use `--header` or `--oauth2Bearer`; `--apiKey` is refused there.

## Several servers from a config file

`--config` reads the `mcpServers` file that Claude Desktop and other MCP clients use, so a client's file works as-is. Each server is served at `/<name>` on one port:

```jsonc
{
  "port": 8000,
  "mcpServers": {
    "git": { "command": "uvx", "args": ["mcp-server-git"] },
    "files": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./my-folder"],
      "outputTransport": "streamableHttp",
      "apiKey": "${FILES_KEY}",
    },
  },
}
```

```bash
npx -y supergateway --config servers.json
```

- `git` is served over SSE at `http://localhost:8000/git/sse` and `/git/message`; `files` over Streamable HTTP at `http://localhost:8000/files/mcp`.
- **A server** is `command` + `args` (run without a shell, as clients run them), `stdio` (a shell command line, as `--stdio`), or `url` + `type` (`sse` or `http`). `env` and `cwd` set its environment and directory.
- **Any option** from the list above can be set on a server, by its flag name (`outputTransport`, `stateful`, `cors`, `headers`, `apiKey`, `healthEndpoint`, `toolPrefix`, `tools`, ...). Set at the top level, it is the default for every server. Defaults are the command line's: a local server is served over SSE, a `url` one on stdio.
- **`path`** serves a server somewhere other than `/<name>`. A name that can't be part of a URL needs one. The gateway refuses to start if a server's URL would be answered by another server or by the gateway's own `healthEndpoint`.
- **`port`, `host`, `logLevel`, `logFormat`, `exitWithProcess`** and the top-level `healthEndpoint` are the gateway's own. A top-level `healthEndpoint` answers for the whole gateway; one on a server is under that server's path. With `"healthCheck": "server"`, a server's own health endpoints check that server; the gateway's stay `"ok"` while the gateway is up, so one failing server doesn't fail the whole gateway.
- **`apiKey`** on a server locks that server only. Keys from `--apiKey`, `--apiKeyFile` or `SUPERGATEWAY_API_KEY` lock every server.
- **`"disabled": true`** skips a server. Keys only clients use (`autoApprove`, `timeout`, `disabledTools`, ...) are warned about and ignored. Any other unknown key is an error that suggests the closest known one.
- **`${VAR}`**, `${VAR:-default}` and `${env:VAR}` are replaced from the environment in every value except a `stdio` command line, which the shell expands itself. A variable that isn't set is an error. `$$` is a literal `$`.
- **Flags beside `--config`** may be the gateway's own (`--port`, `--host`, `--logLevel`, `--logFormat`, `--exitWithProcess`, `--healthEndpoint`, `--apiKey`, `--apiKeyFile`). They override the file, and the startup log says so. A server flag such as `--stateful` is refused, because it would be unclear which server it means.
- With more than one server, each log line about a server starts with its name (`[git]`), and JSON logs give it a `server` field.
- On Windows, `"command": "npx"` needs `npx.cmd`, as it does in Claude Desktop, since `command` runs without a shell. `stdio` runs through the shell.
- Comments and trailing commas are allowed (JSONC). Run `--checkConfig` after editing.
- **For completion and checking in an editor,** point `$schema` at the JSON Schema that ships with the package: `"$schema": "https://raw.githubusercontent.com/supercorp-ai/supergateway/main/config.schema.json"`, or `./node_modules/supergateway/config.schema.json` for the version installed. It knows every key, and other clients' keys too. The gateway itself checks what a schema can't, such as two servers on one path.

A `url` server is served like a local one when it has an output other than stdio (see [Remote server → SSE, WS or Streamable HTTP](#remote-server--sse-ws-or-streamable-http)): `"outputTransport": "streamableHttp"`, for example.

One `url` server may use stdio output beside servers on the port. This is for a client that launches Supergateway with a config file, such as Claude Desktop: it talks to that server over stdin and stdout, and other clients reach the rest over HTTP. All logs then go to stderr. The process belongs to the client that started it. When stdin closes, a signal arrives, or the stdio server stops (its remote server refused the first connection, for example), every server stops, and the exit code is the stdio server's.

### Combining servers on one URL

An entry with its own `mcpServers` serves them as one MCP server, at the entry's URL:

```jsonc
{
  "port": 8000,
  "outputTransport": "streamableHttp",
  "mcpServers": {
    "dev": {
      "mcpServers": {
        "git": { "command": "uvx", "args": ["mcp-server-git"] },
        "files": {
          "command": "npx",
          "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
        },
        "docs": {
          "url": "https://docs.example.com/mcp",
          "type": "http",
          "toolPrefix": "docs_",
        },
      },
    },
  },
}
```

A client of `http://localhost:8000/dev/mcp` sees the tools, prompts and resources of all three.

- **Names are not changed.** A request goes to the server that has the tool, prompt or resource it names. When two servers offer the same name, the first one listed wins and the other's is hidden; the log says so once. Set `toolPrefix` on a server to keep both, and `tools` to choose which of a server's tools are shown. Many tools behind one URL make a model's choice harder, so combine what belongs together.
- **Each session has its own servers,** started when the client initializes. A server that can't start is left out, with a line in the log; the session fails only if none starts. A server that stops later fails the calls it had, the client is told the lists changed, and the rest go on.
- **Requests from a server to the client** (sampling, roots, elicitation) work as they do for one server, on outputs that carry them (SSE, WebSocket, stateful Streamable HTTP).
- **The protocol version** is the lowest any of the servers answers; the capabilities are everything any of them has; their `instructions` are joined, each under its server's name.
- **Lists come as one page,** every server's in the order listed.
- **Settings for the URL** (`outputTransport`, `apiKey`, `cors`, `healthEndpoint`, ...) go on the entry. A combined server has `command`/`args`/`env`/`cwd`, `stdio`, or `url`/`type`/`headers`/`oauth2Bearer`, and `toolPrefix`/`tools`. Combining goes one level deep.
- **On stdio** (`"outputTransport": "stdio"`), a combined entry is what a desktop client launches to reach several servers through one entry of its own config. It can run beside servers on the port, as a single remote server can.
- **Not yet:** the 2026-07-28 protocol version (a combined entry answers the earlier ones), and tasks. Combined servers share one model context, so combine only servers you trust with each other's results.

## Shutdown

Allow more than five seconds for graceful shutdown. Child servers should handle SIGTERM when you stop the gateway with Ctrl-C.

For network-output gateways, closing a pipe connected to stdin also stops the gateway. Starting with stdin ignored or redirected from `/dev/null` keeps it running.

## Example with MCP Inspector (stdio → SSE mode)

1. **Run Supergateway**:

```bash
npx -y supergateway --port 8000 \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /Users/MyName/Desktop"
```

2. **Use MCP Inspector**:

```bash
npx @modelcontextprotocol/inspector
```

You can now list tools, resources, or perform MCP actions via Supergateway.

## Using with ngrok

Use [ngrok](https://ngrok.com/) to share your local MCP server publicly:

```bash
npx -y supergateway --port 8000 --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# In another terminal:
ngrok http 8000
```

ngrok provides a public URL for remote access.

MCP server will be available at URL similar to: https://1234-567-890-12-456.ngrok-free.app/sse

## Running with Docker

A Docker-based workflow avoids local Node.js setup. A ready-to-run Docker image is available here:
[supercorp/supergateway](https://hub.docker.com/r/supercorp/supergateway). Also on GHCR: [ghcr.io/supercorp-ai/supergateway](https://github.com/supercorp-ai/supergateway/pkgs/container/supergateway)

### Using the Official Image

```bash
docker run -it --rm -p 8000:8000 supercorp/supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --port 8000
```

Docker pulls the image automatically. The MCP server runs in the container’s root directory (`/`). You can mount host directories if needed.

#### Images with dependencies

Pull any of these pre-built Supergateway images for various dependencies you might need.

- **uvx**
  Supergateway + uv/uvx, so you can call `uvx` directly:

  ```bash
  docker run -it --rm -p 8000:8000 supercorp/supergateway:uvx \
    --stdio "uvx mcp-server-fetch"
  ```

- **deno**
  Supergateway + Deno, ready to run Deno-based MCP servers:
  ```bash
  docker run -it --rm -p 8000:8000 supercorp/supergateway:deno \
    --stdio "deno run -A jsr:@omedia/mcp-server-drupal --drupal-url https://your-drupal-server.com"
  ```

### Building the Image Yourself

Build from this checkout:

```bash
npm ci
npm run pack:release
docker build -f docker/base.Dockerfile -t supergateway \
  --build-arg VERSION="$(node -p "require('./.release/manifest.json').version")" \
  --build-arg PACKAGE_SHA256="$(node -p "require('./.release/manifest.json').sha256")" .

docker run -it --rm -p 8000:8000 supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem ."
```

## Using with Claude Desktop (SSE → stdio mode)

Claude Desktop can use Supergateway’s SSE→stdio mode.

### NPX-based MCP Server Example

```json
{
  "mcpServers": {
    "supermachineExampleNpx": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

### Docker-based MCP Server Example

```json
{
  "mcpServers": {
    "supermachineExampleDocker": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "supercorp/supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

## Using with Cursor (SSE → stdio mode)

Cursor can also integrate with Supergateway in SSE→stdio mode. The configuration is similar to Claude Desktop.

### NPX-based MCP Server Example for Cursor

```json
{
  "mcpServers": {
    "cursorExampleNpx": {
      "command": "npx",
      "args": [
        "-y",
        "supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

### Docker-based MCP Server Example for Cursor

```json
{
  "mcpServers": {
    "cursorExampleDocker": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "supercorp/supergateway",
        "--sse",
        "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
      ]
    }
  }
}
```

**Note:** Although the setup supports sending headers via the `--header` flag, if you need to pass an Authorization header (which typically includes a space, e.g. `"Bearer 123"`), you must use the `--oauth2Bearer` flag due to a known Cursor bug with spaces in command-line arguments.

## Troubleshooting

### `--baseUrl` host is not used

In stdio→SSE mode only the path of `--baseUrl` reaches clients: `--baseUrl https://mcp.example.com/gateway` makes the message endpoint `/gateway/message`, and clients post to the host they connected through. Clients that need an absolute endpoint URL, such as Copilot Studio, should use `--outputTransport streamableHttp`.

## Why MCP?

[Model Context Protocol](https://spec.modelcontextprotocol.io/) standardizes AI tool interactions. Supergateway converts MCP stdio servers into SSE or WS services, simplifying integration and debugging with web-based or remote clients.

## Additional resources

- [Superargs](https://github.com/supercorp-ai/superargs) - provide arguments to MCP servers during runtime.

## Contributors

- [@jakajancar](https://github.com/jakajancar)
- [@thedadams](https://github.com/thedadams)
- [@iutx](https://github.com/iutx)
- [@hxy91819](https://github.com/hxy91819)
- [@gamedevsam](https://github.com/gamedevsam)
- [@davidferlay](https://github.com/davidferlay)
- [@bossanyit](https://github.com/bossanyit)
- [@bbracha-evinced](https://github.com/bbracha-evinced)
- [@homer6](https://github.com/homer6)
- [@aleleba](https://github.com/aleleba)
- [@bimax](https://github.com/bimax)
- [@essentialols](https://github.com/essentialols)
- [@gcoinstash-cmd](https://github.com/gcoinstash-cmd)
- [@nullStack65](https://github.com/nullStack65)
- [@srijan](https://github.com/srijan)
- [@TheItschi](https://github.com/TheItschi)
- [@wowsofine](https://github.com/wowsofine)
- [@yanziwei](https://github.com/yanziwei)
- [@tttcoding666](https://github.com/tttcoding666)
- [@aneasystone](https://github.com/aneasystone)
- [@luyunfeng-bytedance](https://github.com/luyunfeng-bytedance)
- [@kvick-games](https://github.com/kvick-games)
- [@nowireless4u](https://github.com/nowireless4u)
- [@paul-maas](https://github.com/paul-maas)
- [@ArnaudBger](https://github.com/ArnaudBger)
- [@alvaroalon2](https://github.com/alvaroalon2)
- [@oshaban](https://github.com/oshaban)
- [@springbrookconsultingllc-byte](https://github.com/springbrookconsultingllc-byte)
- [@jstar0](https://github.com/jstar0)
- [@v8eta](https://github.com/v8eta)
- [@zaggash](https://github.com/zaggash)
- [@0xt3ch](https://github.com/0xt3ch)
- [@werebear73](https://github.com/werebear73)
- [@move-hoon](https://github.com/move-hoon)
- [@dustindoan](https://github.com/dustindoan)
- [@swarthyplacebo](https://github.com/swarthyplacebo)
- [@ildunari](https://github.com/ildunari)
- [@tamermina](https://github.com/tamermina)
- [@frankstupak](https://github.com/frankstupak)
- [@brainoir](https://github.com/brainoir)
- [@JuliaF1988](https://github.com/JuliaF1988)
- [@terjefl](https://github.com/terjefl)
- [@yangzinan](https://github.com/yangzinan)
- [@ckhsponge](https://github.com/ckhsponge)
- [@AxelFooley](https://github.com/AxelFooley)
- [@Growdy](https://github.com/Growdy)
- [@sulivanti](https://github.com/sulivanti)
- [@EvanSchalton](https://github.com/EvanSchalton)
- [@suneetagarwalre-boop](https://github.com/suneetagarwalre-boop)
- [@edmcman](https://github.com/edmcman)
- [@noyoa](https://github.com/noyoa)
- [@JamesSlocumIH](https://github.com/JamesSlocumIH)
- [@mike12806](https://github.com/mike12806)
- [@oscar-izval](https://github.com/oscar-izval)
- [@haissamtariqzaman](https://github.com/haissamtariqzaman)
- [@rubenmajor2](https://github.com/rubenmajor2)
- [@quigles1977](https://github.com/quigles1977)
- [@jmcgurk2](https://github.com/jmcgurk2)
- [@maxx3250](https://github.com/maxx3250)
- [@julioccorderoc](https://github.com/julioccorderoc)
- [@logan-crosby](https://github.com/logan-crosby)
- [@BishopMartin](https://github.com/BishopMartin)
- [@gkinter](https://github.com/gkinter)
- [@JoeLuker](https://github.com/JoeLuker)
- [@agerit-programator2](https://github.com/agerit-programator2)
- [@sfasching](https://github.com/sfasching)
- [@RussellZager](https://github.com/RussellZager)
- [@Farzy](https://github.com/Farzy)
- [@body-cmd](https://github.com/body-cmd)
- [@cosmic-fire-eng](https://github.com/cosmic-fire-eng)
- [@0xbrainkid](https://github.com/0xbrainkid)
- [@dangdinhquan](https://github.com/dangdinhquan)
- [@iandol](https://github.com/iandol)
- [@micci184](https://github.com/micci184)
- [@manmao](https://github.com/manmao)
- [@sibelius](https://github.com/sibelius)
- [@NathanNeves](https://github.com/NathanNeves)
- [@Avi-Robusta](https://github.com/Avi-Robusta)
- [@yakovyarmo](https://github.com/yakovyarmo)
- [@GhimBoon](https://github.com/GhimBoon)
- [@akirilyuk](https://github.com/akirilyuk)
- [@ongeluk](https://github.com/ongeluk)
- [@dparkmit24](https://github.com/dparkmit24)
- [@glani](https://github.com/glani)
- [@enxilium](https://github.com/enxilium)
- [@scalabreseGD](https://github.com/scalabreseGD)
- [@davidjitca](https://github.com/davidjitca)
- [@sbatista-uc](https://github.com/sbatista-uc)
- [@terafin](https://github.com/terafin)
- [@ecdesigns2007](https://github.com/ecdesigns2007)
- [@brendandebeasi](https://github.com/brendandebeasi)
- [@waldman](https://github.com/waldman)
- [@O7Furkan17](https://github.com/O7Furkan17)
- [@HalmSascha](https://github.com/HalmSascha)
- [@Paul-Kyle](https://github.com/Paul-Kyle)
- [@janosborst](https://github.com/janosborst)
- [@MartinZvelebil](https://github.com/MartinZvelebil)
- [@longfin](https://github.com/longfin)
- [@griffinqiu](https://github.com/griffinqiu)
- [@folkvir](https://github.com/folkvir)
- [@wizizm](https://github.com/wizizm)
- [@dtinth](https://github.com/dtinth)
- [@rajivml](https://github.com/rajivml)
- [@NicoBonaminio](https://github.com/NicoBonaminio)
- [@sibbl](https://github.com/sibbl)
- [@podarok](https://github.com/podarok)
- [@jmn8718](https://github.com/jmn8718)
- [@TraceIvan](https://github.com/TraceIvan)
- [@zhoufei0622](https://github.com/zhoufei0622)
- [@ezyang](https://github.com/ezyang)
- [@aleksadvaisly](https://github.com/aleksadvaisly)
- [@wuzhuoquan](https://github.com/wuzhuoquan)
- [@mantrakp04](https://github.com/mantrakp04)
- [@mheubi](https://github.com/mheubi)
- [@mjmendo](https://github.com/mjmendo)
- [@CyanMystery](https://github.com/CyanMystery)
- [@earonesty](https://github.com/earonesty)
- [@StefanBurscher](https://github.com/StefanBurscher)
- [@tarasyarema](https://github.com/tarasyarema)
- [@pcnfernando](https://github.com/pcnfernando)
- [@Areo-Joe](https://github.com/Areo-Joe)
- [@Joffref](https://github.com/Joffref)
- [@michaeljguarino](https://github.com/michaeljguarino)
- [@qdrddr](https://github.com/qdrddr)
- [@Shellishack](https://github.com/Shellishack)
- [@anyuan95](https://github.com/anyuan95)

## Contributing

Issues and PRs welcome. Please open one if you encounter problems or have feature suggestions. For questions and discussion, join us on [Discord](https://discord.gg/CudcAH53yF).

## Tests

Supergateway is tested with the Node Test Runner.

To run the suite locally you need Node **24+**. Using [nvm](https://github.com/nvm-sh/nvm) you can install and activate it with:

```bash
nvm install 24
nvm use 24
npm install
npm run build
npm test
```

The `tests/helpers/mock-mcp-server.js` script provides a local MCP server so all
tests run without network access.

## License

[MIT License](./LICENSE)
