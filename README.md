![Supergateway: Run stdio MCP servers over SSE and WS](https://raw.githubusercontent.com/supercorp-ai/supergateway/main/supergateway.png)

**Supergateway** runs **MCP stdio-based servers** over **SSE (Server-Sent Events)** or **WebSockets (WS)** with one command. This is useful for remote access, debugging, or connecting to clients when your MCP server only supports stdio.

Supported by [Supermachine](https://supermachine.ai) (hosted MCPs), [Superinterface](https://superinterface.ai), and [Supercorp](https://supercorp.ai).

## Installation & Usage

Run Supergateway via `npx`:

```bash
npx -y supergateway --stdio "uvx mcp-server-git"
```

- **`--stdio "command"`**: Command that runs an MCP server over stdio
- **`--sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"`**: SSE URL to connect to (SSE→stdio mode)
- **`--streamableHttp "https://mcp-server.example.com/mcp"`**: Streamable HTTP URL to connect to (StreamableHttp→stdio mode)
- **`--outputTransport stdio | sse | ws | streamableHttp`**: Output MCP transport (default: `sse` with `--stdio`, `stdio` with `--sse` or `--streamableHttp`)
- **`--port 8000`**: Port to listen on (stdio→SSE or stdio→WS mode, default: `8000`)
- **`--baseUrl "http://localhost:8000"`**: Base URL for SSE or WS clients (stdio→SSE mode; optional)
- **`--ssePath "/sse"`**: Path for SSE subscriptions (stdio→SSE mode, default: `/sse`)
- **`--messagePath "/message"`**: Path for messages (stdio→SSE or stdio→WS mode, default: `/message`)
- **`--streamableHttpPath "/mcp"`**: Path for Streamable HTTP (stdio→Streamable HTTP mode, default: `/mcp`)
- **`--stateful`**: Run stdio→Streamable HTTP in stateful mode
- **`--sessionTimeout 60000`**: Session timeout in milliseconds (stateful stdio→Streamable HTTP mode only)
- **`--header "x-user-id: 123"`**: Add one or more headers (stdio→SSE, SSE→stdio, or Streamable HTTP→stdio mode; can be used multiple times)
- **`--oauth2Bearer "some-access-token"`**: Adds an `Authorization` header with the provided Bearer token
- **`--logLevel debug | info | none`**: Controls logging level (default: `info`). Use `debug` for more verbose logs, `none` to suppress all logs.
- **`--cors`**: Enable CORS (stdio→SSE or stdio→WS mode). Use `--cors` with no values to allow all origins, or supply one or more allowed origins (e.g. `--cors "http://example.com"` or `--cors "/example\\.com$/"` for regex matching).
- **`--healthEndpoint /healthz`**: Register one or more endpoints (stdio→SSE or stdio→WS mode; can be used multiple times) that respond with `"ok"`

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

## Child process shutdown

On POSIX systems (including Linux and macOS), stdio commands run in their own process groups. When their owner ends—a stateful session closes, the wrapper exits, or the gateway shuts down—the gateway sends SIGTERM to the group and allows up to five seconds before sending SIGKILL. Shutdown waits for this cleanup. Completing a stateful HTTP response does not end its session.

For network-output gateways, closing a pipe connected to the gateway's stdin also triggers shutdown. Starting with stdin ignored or redirected from `/dev/null` keeps the gateway running. This supports launchers whose exit closes the pipe connected to gateway stdin; it is not general parent-process death detection or a server-wide idle timeout.

Ctrl-C is handled by the gateway, which sends SIGTERM to its owned children. Child servers should handle SIGTERM for graceful shutdown. The separate POSIX session has no controlling terminal, so commands that require `/dev/tty` may behave differently. Allow more than five seconds for graceful gateway shutdown before forcing termination.

Windows retains direct-child termination. Processes that deliberately create a separate process group or session are outside this cleanup scope. An uncatchable gateway SIGKILL also cannot run cleanup.

In stateless Streamable HTTP mode, completed requests release their child and transport after the HTTP response closes and all pending JSON-RPC requests have replies. A client disconnect alone does not cancel work: the child stays alive until its pending work replies or the child/gateway terminates. There is no new execution timeout or response replay after disconnection.

Notification-only POSTs return HTTP 202 before processing completes. The gateway finishes auto-initialization and forwards the message before closing child stdin, then allows five seconds for voluntary exit before starting the SIGTERM/SIGKILL cleanup above. This grace period can add up to five seconds to the child's lifetime; notifications have no completion acknowledgment, so it does not guarantee completion of arbitrary background work.

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

Use provided Dockerfile:

```bash
docker build -f docker/base.Dockerfile -t supergateway .

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

## Why MCP?

[Model Context Protocol](https://spec.modelcontextprotocol.io/) standardizes AI tool interactions. Supergateway converts MCP stdio servers into SSE or WS services, simplifying integration and debugging with web-based or remote clients.

## Advanced Configuration

Supergateway emphasizes modularity:

- Automatically manages JSON-RPC versioning.
- Retransmits package metadata where possible.
- stdio→SSE or stdio→WS mode logs via standard output; SSE→stdio mode logs via stderr.

## Additional resources

- [Superargs](https://github.com/supercorp-ai/superargs) - provide arguments to MCP servers during runtime.

## Contributors

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

## Contributing

Issues and PRs welcome. Please open one if you encounter problems or have feature suggestions.

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
