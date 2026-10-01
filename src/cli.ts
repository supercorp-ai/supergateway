import yargs from 'yargs'
import { getVersion } from './lib/getVersion.js'

export type InputTransport = 'stdio' | 'sse' | 'streamableHttp'

// Idle lifetime of a stateful session when the flag is absent. See
// sessionTimeoutOf for why "never" was the wrong default.
export const defaultSessionTimeout = 30 * 60 * 1000

// Express routes only match paths that start with `/`. `--ssePath sse` used to
// register a route no request could reach, so every request got a 404, and
// the startup log printed `http://localhost:8000sse`.
const routePath = (path: string) => (path.startsWith('/') ? path : `/${path}`)

/** The command line, as every gateway reads it. */
export function parseCli(args: string[]) {
  return yargs(args)
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
      default: () => {
        if (args.includes('--stdio')) return 'sse'
        if (args.includes('--sse')) return 'stdio'
        if (args.includes('--streamableHttp')) return 'stdio'

        return undefined
      },
      description:
        'Transport for output. Default is "sse" when using --stdio and "stdio" when using --sse or --streamableHttp.',
    })
    .option('port', {
      type: 'number',
      default: 8000,
      description: '(stdio→SSE, stdio→WS) Port for output MCP server',
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
    .help()
    .parseSync()
}

export type Cli = ReturnType<typeof parseCli>

/**
 * The one input transport the command line names, or why there is not one.
 *
 * One value rather than three booleans, so the compiler knows the cases are
 * mutually exclusive and can check that every one is handled. Three
 * independent flags cannot express that, which is why the old dispatch needed
 * a runtime `else` nothing could ever reach.
 */
export function inputTransportOf(
  argv: Cli,
): { input: InputTransport } | { error: string } {
  const inputs: InputTransport[] = []
  if (argv.stdio) inputs.push('stdio')
  if (argv.sse) inputs.push('sse')
  if (argv.streamableHttp) inputs.push('streamableHttp')
  if (inputs.length === 0)
    return {
      error:
        'Error: You must specify one of --stdio, --sse, or --streamableHttp',
    }
  if (inputs.length > 1)
    return {
      error:
        'Error: Specify only one of --stdio, --sse, or --streamableHttp, not multiple',
    }
  return { input: inputs[0] }
}

/**
 * A stateful session's idle lifetime, or why the flag's value is unusable.
 *
 * A stateful session owns a child process, and the only thing that used to
 * release it was the client explicitly deleting the session. A client that
 * crashes, is force-quit, or simply closes its transport never sends that, so
 * every such disconnect leaked a process for the lifetime of the gateway.
 * Thirty minutes is far longer than any gap between calls in a live session
 * and still bounds what a vanished client can strand.
 */
export function sessionTimeoutOf(
  argv: Cli,
): { sessionTimeout: number } | { error: string } {
  if (typeof argv.sessionTimeout !== 'number')
    return { sessionTimeout: defaultSessionTimeout }
  // Negated so that NaN (`--sessionTimeout 30m`) fails too: `NaN <= 0` is
  // false, and it used to switch the default timeout off.
  if (!(argv.sessionTimeout > 0))
    return {
      error: `Error: \`sessionTimeout\` must be a positive number, received: ${argv.sessionTimeout}`,
    }
  return { sessionTimeout: argv.sessionTimeout }
}
