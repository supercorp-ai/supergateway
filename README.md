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
- **`--outputTransport stdio | sse | ws`**: Output MCP transport (default: `sse` with `--stdio`, `stdio` with `--sse`)
- **`--port 8000`**: Port to listen on (stdio→SSE or stdio→WS mode, default: `8000`)
- **`--baseUrl "http://localhost:8000"`**: Base URL for SSE or WS clients (stdio→SSE mode; optional)
- **`--ssePath "/sse"`**: Path for SSE subscriptions (stdio→SSE mode, default: `/sse`)
- **`--messagePath "/message"`**: Path for messages (stdio→SSE or stdio→WS mode, default: `/message`)
- **`--logLevel info | none`**: Controls logging level (default: `info`). Use `none` to suppress all logs.
- **`--cors`**: Enable CORS (stdio→SSE or stdio→WS mode)
- **`--healthEndpoint /healthz`**: Register one or more endpoints (stdio→SSE or stdio→WS mode; can be used multiple times) that respond with `"ok"`

## stdio → SSE

Expose an MCP stdio server as an SSE server:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --ssePath /sse --messagePath /message
```

You can also pass header(s) when sending requests. This is useful for Auth:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --baseUrl http://localhost:8000 \
    --ssePath /sse --messagePath /message \
    --header "Authorization: Bearer <token>"
```

- **Subscribe to events**: `GET http://localhost:8000/sse`
- **Send messages**: `POST http://localhost:8000/message`

## SSE → stdio

Connect to a remote SSE server and expose locally via stdio:

```bash
npx -y supergateway --sse "https://mcp-server-ab71a6b2-cd55-49d0-adba-562bc85956e3.supermachine.app"
```

Useful for integrating remote SSE MCP servers into local command-line environments.

## stdio → WS

Expose an MCP stdio server as a WebSocket server:

```bash
npx -y supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ./my-folder" \
    --port 8000 --outputTransport ws --messagePath /message
```

- **WebSocket endpoint**: `ws://localhost:8000/message`

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
npx -y supergateway --port 8000 \
    --stdio "npx -y @modelcontextprotocol/server-filesystem ."

# In another terminal:
ngrok http 8000
```

ngrok provides a public URL for remote access.

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

### Building the Image Yourself

Use provided Dockerfile:

```bash
docker build -t supergateway .

docker run -it --rm -p 8000:8000 supergateway \
    --stdio "npx -y @modelcontextprotocol/server-filesystem /" \
    --port 8000
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

- [@Joffref](https://github.com/Joffref)
- [@michaeljguarino](https://github.com/michaeljguarino)

## Contributing

Issues and PRs welcome. Please open one if you encounter problems or have feature suggestions.

## License

[MIT License](./LICENSE)
