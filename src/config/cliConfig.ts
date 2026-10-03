import type { Cli } from '../cli.js'
import type { ChildCommand } from '../lib/childCommand.js'
import { isSensitiveHeader } from '../lib/headers.js'
import type {
  Config,
  EndpointOptions,
  Entry,
  GatewaySettings,
  InnerServer,
} from './configFile.js'

// The command line and the config file describe the same thing: the command
// line is a config with one entry, named `default`, served at `/`.

/** The flags that may sit beside `--config`, overriding the file. */
export const GATEWAY_FLAGS = [
  'port',
  'host',
  'logLevel',
  'logFormat',
  'exitWithProcess',
  'healthEndpoint',
  'apiKey',
  'apiKeyFile',
] as const

const CONFIG_FLAGS = ['config', 'printConfig', 'checkConfig']

/**
 * A flag beside `--config` that describes one server or URL, if any. Those
 * are refused: with several entries, `--stateful` could mean all of them or
 * just one, and either reading would surprise someone.
 */
export function entryFlagBesideConfig(given: Set<string>) {
  return [...given].find(
    (name) =>
      !CONFIG_FLAGS.includes(name) &&
      !(GATEWAY_FLAGS as readonly string[]).includes(name),
  )
}

// How each setting is read from the command line, once its flag is given.
// Settings are read, and so printed, in the order listed here.
type FromCli<T> = { [K in keyof T]-?: (argv: Cli) => T[K] }

const GATEWAY_FROM_CLI: FromCli<GatewaySettings> = {
  port: (argv) => argv.port,
  host: (argv) => argv.host,
  logLevel: (argv) => argv.logLevel as GatewaySettings['logLevel'],
  logFormat: (argv) => argv.logFormat as GatewaySettings['logFormat'],
  exitWithProcess: (argv) => argv.exitWithProcess,
  healthEndpoint: (argv) => (argv.healthEndpoint as unknown[]).map(String),
}

// `--healthEndpoint` is the gateway's own, so it is read above.
const ENDPOINT_FROM_CLI: FromCli<Omit<EndpointOptions, 'healthEndpoint'>> = {
  outputTransport: (argv) => argv.outputTransport as Entry['outputTransport'],
  baseUrl: (argv) => argv.baseUrl,
  ssePath: (argv) => argv.ssePath,
  messagePath: (argv) => argv.messagePath,
  streamableHttpPath: (argv) => argv.streamableHttpPath,
  healthCheck: (argv) => argv.healthCheck as Entry['healthCheck'],
  cors: (argv) => {
    // Given, it is a list: empty for a bare --cors.
    const origins = (argv.cors as unknown[]).map(String)
    return origins.length === 0 ? true : origins
  },
  headers: (argv) => headerMap(argv.header as unknown[]),
  oauth2Bearer: (argv) => argv.oauth2Bearer,
  apiKey: (argv) => argv.apiKey as string[],
  apiKeyFile: (argv) => argv.apiKeyFile,
  stateful: (argv) => argv.stateful,
  sessionTimeout: (argv) => argv.sessionTimeout,
  protocolVersion: (argv) => argv.protocolVersion,
}

// Each setting has the name of its flag, but for `headers`, which the command
// line gives one `--header` at a time.
const flagOf = (setting: string) => (setting === 'headers' ? 'header' : setting)

// The settings whose flags were given, as the command line set them.
function settingsFromCli<T>(
  argv: Cli,
  given: Set<string>,
  readers: FromCli<T>,
): T {
  const settings: Record<string, unknown> = {}
  // Never empty, so not a `for` loop with a zero-iteration case.
  Object.entries<(argv: Cli) => unknown>(readers).forEach(([key, read]) => {
    if (given.has(flagOf(key))) settings[key] = read(argv)
  })
  return settings as T
}

/** The config a command line without `--config` is equivalent to. */
export function configFromCli(argv: Cli, given: Set<string>): Config {
  const gateway = settingsFromCli(argv, given, GATEWAY_FROM_CLI)
  const options = settingsFromCli(argv, given, ENDPOINT_FROM_CLI)
  const source = sourceFromCli(argv)
  return {
    gateway,
    defaults: {},
    entries: [{ name: 'default', path: '/', ...options, server: { source } }],
  }
}

// The server a command line names: --sse, --streamableHttp or --stdio.
function sourceFromCli(argv: Cli): InnerServer['source'] {
  if (argv.sse) return { kind: 'url', url: argv.sse, type: 'sse' }
  if (argv.streamableHttp)
    return { kind: 'url', url: argv.streamableHttp, type: 'streamableHttp' }
  // Called only for a command line that names its one server.
  return { kind: 'stdio', stdio: argv.stdio! }
}

// `--header "Name: value"` as the file writes it. A header without a colon is
// one the command line ignores with a warning, so it has no place here either.
function headerMap(headers: unknown[]) {
  const map: Record<string, string> = {}
  for (const header of headers.map(String)) {
    const colon = header.indexOf(':')
    if (colon > 0)
      map[header.slice(0, colon).trim()] = header.slice(colon + 1).trim()
  }
  return map
}

/**
 * Applies the gateway-wide flags given beside `--config` to the file's
 * settings, and says what each one replaced, for the startup log. Keys from
 * `--apiKey` and `--apiKeyFile` are accepted on every URL, in addition to the
 * file's, so a key passed at deploy time locks every entry.
 */
export function overrideFromCli(
  config: Config,
  argv: Cli,
  given: Set<string>,
): {
  config: Config
  extraKeys: string[]
  extraKeyFiles: string[]
  notes: string[]
} {
  const gateway: Record<string, unknown> = { ...config.gateway }
  const overrides = settingsFromCli(argv, given, GATEWAY_FROM_CLI)
  const notes = Object.entries(overrides).map(([key, value]) => {
    const replaced =
      key in gateway
        ? `"${key}": ${JSON.stringify(gateway[key])}`
        : 'the default'
    gateway[key] = value
    return `--${key} ${JSON.stringify(value)} overrides ${replaced} from the config file`
  })
  return {
    config: { ...config, gateway: gateway as GatewaySettings },
    extraKeys: extraKeysOf(argv, given),
    extraKeyFiles: given.has('apiKeyFile') ? [argv.apiKeyFile as string] : [],
    notes,
  }
}

// Given but empty (`--apiKey`, `--apiKeyFile "$UNSET"`) is passed on, so it
// is refused as it is without --config ("is set but empty"). Dropped, it
// would start the gateway without the key the operator meant to require.
function extraKeysOf(argv: Cli, given: Set<string>) {
  if (!given.has('apiKey')) return []
  const keys = argv.apiKey as string[]
  return keys.length > 0 ? keys : ['']
}

/** The config as a file would write it, secrets redacted. */
export function printableConfig(config: Config): unknown {
  const options = (o: EndpointOptions) => {
    const out: Record<string, unknown> = { ...o }
    if (o.apiKey) out.apiKey = o.apiKey.map(() => '<redacted>')
    if (o.oauth2Bearer) out.oauth2Bearer = '<redacted>'
    if (o.headers) out.headers = redactMap(o.headers)
    return out
  }
  const server = (s: Omit<InnerServer, 'name'>) => {
    const out = sourceFields(s.source)
    if (s.env) out.env = redactMap(s.env)
    if (s.cwd) out.cwd = s.cwd
    if (s.headers) out.headers = redactMap(s.headers)
    if (s.oauth2Bearer) out.oauth2Bearer = '<redacted>'
    return out
  }
  const entries = Object.fromEntries(
    config.entries.map(({ name, path, server: s, ...rest }) => [
      name,
      {
        ...('members' in s
          ? {
              mcpServers: Object.fromEntries(
                s.members.map(({ name: member, ...m }) => [member, server(m)]),
              ),
            }
          : server(s)),
        ...(path === `/${name}` ? {} : { path }),
        ...options(rest),
      },
    ]),
  )
  return { ...config.gateway, ...options(config.defaults), mcpServers: entries }
}

// What to run, or where to connect, as a file writes it.
function sourceFields(source: InnerServer['source']): Record<string, unknown> {
  if (source.kind === 'command')
    return { command: source.command, args: source.args }
  if (source.kind === 'stdio') return { stdio: source.stdio }
  return { type: source.type, url: source.url }
}

const redactMap = (map: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(map).map(([name, value]) => [
      name,
      isSensitiveHeader(name) ? '<redacted>' : value,
    ]),
  )

/**
 * The command line one entry is equivalent to, and how to start its server.
 * A config file runs through exactly the code a command line does.
 *
 * `shared` is for an entry served beside others: the gateway's own health
 * endpoints are then the gateway's to answer, not each entry's.
 */
export function cliForEntry(
  config: Config,
  entry: Entry,
  extraKeys: string[],
  extraKeyFiles: string[],
  shared = false,
): { args: string[]; command?: ChildCommand } {
  if ('members' in entry.server)
    throw new Error('A combined entry has no command line equivalent')
  const { gateway, defaults } = config
  const pick = <K extends keyof EndpointOptions>(key: K) =>
    entry[key] ?? defaults[key]
  const args: string[] = []
  const flag = (name: string, value: unknown) => {
    if (value !== undefined) args.push(`--${name}=${String(value)}`)
  }
  const { source } = entry.server
  if (source.kind === 'url') {
    flag(source.type, source.url)
  } else {
    // The value is replaced by `command`; the flag only selects the mode.
    flag('stdio', source.kind === 'stdio' ? source.stdio : source.command)
  }
  flag('port', gateway.port)
  flag('host', gateway.host)
  flag('logLevel', gateway.logLevel)
  flag('logFormat', gateway.logFormat)
  flag('exitWithProcess', gateway.exitWithProcess)
  flag('outputTransport', pick('outputTransport'))
  flag('baseUrl', pick('baseUrl'))
  const prefix = entry.path === '/' ? '' : entry.path
  const under = (path: string | undefined, fallback: string) =>
    prefix ? `${prefix}${path ?? fallback}` : path
  flag('ssePath', under(pick('ssePath'), '/sse'))
  flag('messagePath', under(pick('messagePath'), '/message'))
  flag('streamableHttpPath', under(pick('streamableHttpPath'), '/mcp'))
  if (!shared)
    for (const path of gateway.healthEndpoint ?? [])
      flag('healthEndpoint', path)
  for (const path of entry.healthEndpoint ?? [])
    flag('healthEndpoint', path === '/' ? prefix || '/' : `${prefix}${path}`)
  flag('healthCheck', pick('healthCheck'))
  const cors = pick('cors')
  if (cors === true) args.push('--cors')
  else for (const origin of cors ?? []) flag('cors', origin)
  for (const [name, value] of Object.entries(pick('headers') ?? {}))
    flag('header', `${name}: ${value}`)
  flag('oauth2Bearer', pick('oauth2Bearer'))
  for (const key of [...(pick('apiKey') ?? []), ...extraKeys])
    flag('apiKey', key)
  for (const file of [pick('apiKeyFile'), ...extraKeyFiles])
    flag('apiKeyFile', file)
  if (pick('stateful')) args.push('--stateful')
  flag('sessionTimeout', pick('sessionTimeout'))
  flag('protocolVersion', pick('protocolVersion'))
  return { args, command: childCommand(entry.server) }
}

// How to start a local server: a command and its arguments, or a shell
// command line, with an environment and directory if the file gives them.
function childCommand({
  source,
  env,
  cwd,
}: Omit<InnerServer, 'name'>): ChildCommand | undefined {
  if (source.kind === 'url') return undefined
  if (source.kind === 'command')
    return { command: source.command, args: source.args, env, cwd }
  return env || cwd ? { stdio: source.stdio, env, cwd } : source.stdio
}
