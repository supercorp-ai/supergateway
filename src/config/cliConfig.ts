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

/** The config a command line without `--config` is equivalent to. */
export function configFromCli(argv: Cli, given: Set<string>): Config {
  const has = (name: string) => given.has(name)
  const gateway: GatewaySettings = {}
  if (has('port')) gateway.port = argv.port
  if (has('host')) gateway.host = argv.host
  if (has('logLevel'))
    gateway.logLevel = argv.logLevel as GatewaySettings['logLevel']
  if (has('logFormat'))
    gateway.logFormat = argv.logFormat as GatewaySettings['logFormat']
  if (has('exitWithProcess')) gateway.exitWithProcess = argv.exitWithProcess
  if (has('healthEndpoint'))
    gateway.healthEndpoint = (argv.healthEndpoint as unknown[]).map(String)
  const options: EndpointOptions = {}
  if (has('outputTransport'))
    options.outputTransport = argv.outputTransport as Entry['outputTransport']
  if (has('baseUrl')) options.baseUrl = argv.baseUrl
  if (has('ssePath')) options.ssePath = argv.ssePath
  if (has('messagePath')) options.messagePath = argv.messagePath
  if (has('streamableHttpPath'))
    options.streamableHttpPath = argv.streamableHttpPath
  if (has('cors')) {
    // Given, it is a list: empty for a bare --cors.
    const origins = (argv.cors as unknown[]).map(String)
    options.cors = origins.length === 0 ? true : origins
  }
  if (has('header')) options.headers = headerMap(argv.header as unknown[])
  if (has('oauth2Bearer')) options.oauth2Bearer = argv.oauth2Bearer
  if (has('apiKey')) options.apiKey = argv.apiKey as string[]
  if (has('apiKeyFile')) options.apiKeyFile = argv.apiKeyFile
  if (has('stateful')) options.stateful = argv.stateful
  if (has('sessionTimeout')) options.sessionTimeout = argv.sessionTimeout
  if (has('protocolVersion')) options.protocolVersion = argv.protocolVersion
  const source: InnerServer['source'] = argv.sse
    ? { kind: 'url', url: argv.sse, type: 'sse' }
    : argv.streamableHttp
      ? { kind: 'url', url: argv.streamableHttp, type: 'streamableHttp' }
      : // Called only for a command line that names its one server.
        { kind: 'stdio', stdio: argv.stdio! }
  return {
    gateway,
    defaults: {},
    entries: [{ name: 'default', path: '/', ...options, server: { source } }],
  }
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
  const gateway = { ...config.gateway }
  const notes: string[] = []
  const take = <K extends keyof GatewaySettings>(
    key: K,
    value: GatewaySettings[K],
  ) => {
    if (!given.has(key)) return
    notes.push(
      `--${key} ${JSON.stringify(value)} overrides ${
        key in gateway
          ? `"${key}": ${JSON.stringify(gateway[key])}`
          : 'the default'
      } from the config file`,
    )
    gateway[key] = value
  }
  take('port', argv.port)
  take('host', argv.host)
  take('logLevel', argv.logLevel as GatewaySettings['logLevel'])
  take('logFormat', argv.logFormat as GatewaySettings['logFormat'])
  take('exitWithProcess', argv.exitWithProcess)
  take(
    'healthEndpoint',
    given.has('healthEndpoint')
      ? (argv.healthEndpoint as unknown[]).map(String)
      : undefined,
  )
  // Given but empty (`--apiKey`, `--apiKeyFile "$UNSET"`) is passed on, so it
  // is refused as it is without --config ("is set but empty"). Dropped, it
  // would start the gateway without the key the operator meant to require.
  const keys = argv.apiKey as string[]
  return {
    config: { ...config, gateway },
    extraKeys: !given.has('apiKey') ? [] : keys.length > 0 ? keys : [''],
    extraKeyFiles: given.has('apiKeyFile') ? [argv.apiKeyFile as string] : [],
    notes,
  }
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
    const out: Record<string, unknown> =
      s.source.kind === 'command'
        ? { command: s.source.command, args: s.source.args }
        : s.source.kind === 'stdio'
          ? { stdio: s.source.stdio }
          : { type: s.source.type, url: s.source.url }
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
  const { source, env, cwd } = entry.server
  let command: ChildCommand | undefined
  if (source.kind === 'url') {
    flag(source.type, source.url)
  } else {
    // The value is replaced by `command`; the flag only selects the mode.
    flag('stdio', source.kind === 'stdio' ? source.stdio : source.command)
    command =
      source.kind === 'command'
        ? { command: source.command, args: source.args, env, cwd }
        : env || cwd
          ? { stdio: source.stdio, env, cwd }
          : source.stdio
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
  return { args, command }
}
