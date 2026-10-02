import yargs from 'yargs'
import { Parser } from 'yargs/helpers'
import { getVersion } from './lib/getVersion.js'
import { normalizeHost } from './lib/listenHost.js'

export type InputTransport = 'stdio' | 'sse' | 'streamableHttp'

// Idle lifetime of a stateful session when the flag is absent. See
// sessionTimeoutOf for why "never" was the wrong default.
export const defaultSessionTimeout = 30 * 60 * 1000

// Express routes only match paths that start with `/`. `--ssePath sse` used to
// register a route no request could reach, so every request got a 404, and
// the startup log printed `http://localhost:8000sse`.
const routePath = (path: string) => (path.startsWith('/') ? path : `/${path}`)

// Every option the gateway accepts. Declared once: parseCli reads the command
// line with it, and unknownArguments asks it what it declares.
const cli = (args: string[]) =>
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

/** The command line, as every gateway reads it. */
export function parseCli(args: string[]) {
  const argv = cli(args).parseSync()
  argv.outputTransport ??= defaultOutputTransport(argv)
  return argv
}

/**
 * The output transport when none is named: SSE for a local server, stdio for
 * a remote one.
 *
 * Decided from what was parsed. It used to look for the literal argument
 * `--stdio`, `--sse` or `--streamableHttp`, so the same flag spelled
 * `--stdio=cmd` or `--streamable-http url`, both of which yargs accepts, left
 * the output transport undefined and the gateway refused to start
 * ("stdio→undefined not supported").
 */
const defaultOutputTransport = (argv: {
  stdio?: string
  sse?: string
  streamableHttp?: string
}) => {
  if (argv.stdio !== undefined) return 'sse'
  if (argv.sse !== undefined || argv.streamableHttp !== undefined)
    return 'stdio'
  return undefined
}

export type Cli = ReturnType<typeof parseCli>

// The name yargs files an option under. It camel-cases a name only when it has
// a hyphen in it, so `--log-level` and `--LOG-LEVEL` set `logLevel`, while
// `--STDIO` and `--log_level` stay options of their own that nothing reads.
const canonical = (name: string) =>
  name.includes('-') ? Parser.camelCase(name) : name

// `getOptions` is public on a yargs 17 instance but missing from its types.
type Declarations = {
  getOptions(): { key: Record<string, unknown> }
}

// What the command line declares, including yargs' own `--help` and
// `--version`, and the two keys every parse adds: `_` and `$0`.
const declaredOptions = () => {
  const { key } = (cli([]) as unknown as Declarations).getOptions()
  return new Set([...Object.keys(key), '_', '$0'].map(canonical))
}

// Each option name as typed, with the spelling to report it by. `-xy` is two
// short options, `--no-x` is `x` negated, and `--x=1` carries its own value.
// Only spells what yargs parsed: which options are unknown comes from the
// parse, so the `--foo` inside a quoted `--stdio "node x --foo"` never warns.
const typedOptions = (args: string[]) =>
  args.flatMap((arg) => {
    const long = /^--([^=]+)/.exec(arg)
    if (long)
      return [long[1], long[1].replace(/^no-/, '')].map((name) => ({
        name: canonical(name),
        spelling: `--${long[1]}`,
      }))
    return arg.startsWith('-')
      ? [...arg.slice(1)].map((name) => ({ name, spelling: `-${name}` }))
      : []
  })

/**
 * A warning for each argument the gateway parsed and will ignore.
 *
 * There is no `.strict()`: yargs takes an option it does not know and carries
 * on, so `--host` before 4.2 or a typo such as `--keepAlive` did nothing, and
 * nobody was told. Refusing them would stop deployments that start today, so
 * the gateway names them instead and carries on as before.
 *
 * yargs files an unknown `--keep-alive` under both `keep-alive` and
 * `keepAlive`, so each is reported once, as typed. Stray positionals are
 * mostly an `--stdio` command that was not quoted: `--stdio npx -y pkg /tmp`
 * runs `npx` and leaves `-y pkg` and `/tmp` behind.
 */
export function unknownArguments(
  args: string[],
  argv: { _: (string | number)[] } & Record<string, unknown>,
): string[] {
  const declared = declaredOptions()
  const typed = typedOptions(args)
  const options = new Set(
    Object.keys(argv)
      .map(canonical)
      .filter((name) => !declared.has(name)),
  )
  const spelling = (name: string) =>
    typed.find((option) => option.name === name)?.spelling ??
    `--${Parser.decamelize(name, '-')}`
  return [
    ...[...options].map(
      (name) => `Ignored unknown option ${spelling(name)} (see --help)`,
    ),
    ...[...new Set(argv._.map(String))].map(
      (arg) =>
        `Ignored unexpected argument ${arg} (an --stdio command with spaces must be quoted)`,
    ),
  ]
}

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

/**
 * The address to listen on, if `--host` names one, or why it cannot be used.
 *
 * Unset, a gateway listens on every interface, as it always has. The bridges
 * listen on nothing, and a flag that restricts who can connect must not be
 * accepted and then ignored, so there it is an error. So is an empty value,
 * as `--host "$UNSET_VARIABLE"` gives, which `listen` would also take to mean
 * every interface.
 */
export function hostOf(
  argv: Cli,
): { host: string | undefined } | { error: string } {
  if (argv.host === undefined) return { host: undefined }
  if (argv.outputTransport === 'stdio')
    return {
      error:
        'Error: --host applies only when supergateway listens (stdio→SSE, stdio→WS or stdio→Streamable HTTP)',
    }
  const host = normalizeHost(argv.host)
  if (host === '')
    return { error: 'Error: --host needs an address, e.g. 127.0.0.1 or ::1' }
  return { host }
}
