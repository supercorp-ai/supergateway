import type { Cli } from '../cli.js'
import type {
  GatewaySettings,
  EndpointOptions,
  Entry,
  Config,
  InnerServer,
} from './configFile.js'
export { cliForEntry, type MemberServer } from './cliForEntry.js'

export { printableConfig } from './printableConfig.js'

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
  // `--toolPrefix ""` is no prefix, which is also the default.
  toolPrefix: (argv) => argv.toolPrefix || undefined,
  tools: (argv) => argv.tools as string[],
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
