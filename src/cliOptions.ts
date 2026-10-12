import yargs from 'yargs'
import { getVersion } from './lib/getVersion.js'

// Express routes only match paths that start with `/`. `--ssePath sse` used to
// register a route no request could reach, so every request got a 404, and
// the startup log printed `http://localhost:8000sse`.
const routePath = (path: string) => (path.startsWith('/') ? path : `/${path}`)

// Every option the gateway accepts. Declared once: parseCli reads the command
// line with it, and unknownArguments asks it what it declares.
export const cli = (args: string[]) =>
  yargs(args)
    .version(getVersion())
    .option('stdio', {
      type: 'string',
      description: 'Command to run an MCP server over Stdio',
    })
    .option('sse', {
      type: 'string',
      description: 'SSE URL to connect to',
    })
    .option('streamableHttp', {
      type: 'string',
      description: 'Streamable HTTP URL to connect to',
    })
    .option('outputTransport', {
      type: 'string',
      choices: ['stdio', 'sse', 'ws', 'streamableHttp'],
      description:
        'Transport for output. Default is "sse" when using --stdio and "stdio" when using --sse or --streamableHttp.',
    })
    .option('port', {
      type: 'number',
      default: 8000,
      description: '(stdio→SSE, stdio→WS) Port for output MCP server',
    })
    .option('host', {
      type: 'string',
      description:
        '(stdio→SSE, stdio→WS, stdio→Streamable HTTP) Address to listen on, e.g. 127.0.0.1 or ::1. Defaults to every interface.',
    })
    .option('baseUrl', {
      type: 'string',
      default: '',
      description: '(stdio→SSE) Base URL for output MCP server',
    })
    .option('ssePath', {
      type: 'string',
      default: '/sse',
      description: '(stdio→SSE) Path for SSE subscriptions',
      coerce: routePath,
    })
    .option('messagePath', {
      type: 'string',
      default: '/message',
      description: '(stdio→SSE, stdio→WS) Path for messages',
      coerce: routePath,
    })
    .option('streamableHttpPath', {
      type: 'string',
      default: '/mcp',
      description: '(stdio→StreamableHttp) Path for StreamableHttp',
      coerce: routePath,
    })
    .option('logLevel', {
      choices: ['debug', 'info', 'none'] as const,
      default: 'info',
      description: 'Logging level',
    })
    .option('logFormat', {
      choices: ['text', 'json'] as const,
      default: 'text',
      description:
        'Log line format: text (default) or json, one JSON object per line',
    })
    .option('cors', {
      type: 'array',
      description:
        'Enable CORS. Use --cors with no values to allow all origins, or supply one or more allowed origins (e.g. --cors "http://example.com" or --cors "/example\\.com$/" for regex matching).',
    })
    .option('healthEndpoint', {
      type: 'array',
      default: [],
      description:
        'One or more endpoints returning "ok", e.g. --healthEndpoint /healthz --healthEndpoint /readyz',
      coerce: (paths: unknown[]) =>
        paths.map((path) => routePath(String(path))),
    })
    .option('toolPrefix', {
      type: 'string',
      description:
        'Put this before every tool name the server lists, e.g. --toolPrefix github_ turns "search" into "github_search". Clients call the tool by that name; the server still gets its own. Used as given: add your own separator',
    })
    .option('tools', {
      type: 'array',
      description:
        "Expose only these tools, by the server's own names, e.g. --tools search --tools get_issue. Other tools are left out of the list, and a call to one gets the error a server gives for a tool it doesn't have",
      coerce: (names: unknown[]) => names.map(String),
    })
    .option('healthCheck', {
      choices: ['gateway', 'server'] as const,
      default: 'gateway',
      description:
        'What the health endpoints check: "gateway" (default) answers "ok" while the gateway is up; "server" also starts the MCP server, initializes and pings it, and answers 503 when it does not respond. The result is reused for 10s.',
    })
    .option('header', {
      type: 'array',
      default: [],
      description:
        'Headers to be added to the request headers, e.g. --header "x-user-id: 123"',
    })
    .option('oauth2Bearer', {
      type: 'string',
      description:
        'Authorization header to be added, e.g. --oauth2Bearer "some-access-token" adds "Authorization: Bearer some-access-token"',
    })
    .option('apiKey', {
      type: 'array',
      // Strings, not numbers: a key like `0123` or `1e3` must stay itself.
      string: true,
      description:
        '(stdio→SSE, stdio→WS, stdio→Streamable HTTP) Require clients to present this key, as `Authorization: Bearer <key>` or `X-API-Key: <key>`. Repeat for several keys. Also SUPERGATEWAY_API_KEY.',
    })
    .option('apiKeyFile', {
      type: 'string',
      description:
        '(stdio→SSE, stdio→WS, stdio→Streamable HTTP) Read keys for --apiKey from this file, one per line. Also SUPERGATEWAY_API_KEY_FILE.',
    })
    .option('stateful', {
      type: 'boolean',
      default: false,
      description:
        'Whether the server is stateful. Only supported for stdio→StreamableHttp.',
    })
    .option('sessionTimeout', {
      type: 'number',
      description:
        'Session timeout in milliseconds. Only supported for stateful stdio→StreamableHttp. Defaults to 30 minutes of idleness; a client that disconnects without terminating its session used to keep its child process alive forever.',
    })
    .option('protocolVersion', {
      type: 'string',
      description:
        'MCP protocol version to use for auto-initialization when the request has no MCP-Protocol-Version header. Defaults to "2024-11-05" if not specified.',
      default: '2024-11-05',
    })
    .option('config', {
      type: 'string',
      description:
        'Read servers and settings from a JSON or JSONC file. It uses "mcpServers" like Claude Desktop, so one of those files works as-is. Gateway-wide flags (--port, --host, --logLevel, --logFormat, --exitWithProcess, --healthEndpoint, --apiKey, --apiKeyFile) override it.',
    })
    .option('printConfig', {
      type: 'boolean',
      description:
        'Print the config this command is equivalent to, secrets redacted, and exit',
    })
    .option('checkConfig', {
      type: 'boolean',
      description: 'Check the --config file and exit',
    })
    .option('exitWithProcess', {
      type: 'number',
      description:
        "Shut down, stopping the MCP server, when process <pid> exits. Pass the launcher's PID (e.g. $$); it need not be the direct parent, so it works through npx. Checked about once a second.",
    })
    .help()
