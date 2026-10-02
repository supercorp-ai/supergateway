import {
  findNodeAtLocation,
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node,
  type ParseError,
} from 'jsonc-parser'

/**
 * The `--config` file: JSON or JSONC, rooted at `mcpServers` like the files
 * Claude Desktop and other clients read, so one of those works unchanged.
 *
 * Three rules:
 * 1. Each entry under `mcpServers` is served at `/<name>`, or at its `path`.
 * 2. An entry runs one server (`command` + `args`, `stdio`, or `url`), or has
 *    its own `mcpServers`, combined on its URL. Nesting is one level deep.
 * 3. An entry takes any CLI option. Top-level keys are defaults for every
 *    entry, beside the gateway-wide settings (port, host, logging).
 *
 * Defaults are the CLI's. This module reads and checks a file; what it means
 * at run time is the caller's.
 */

export type Transport = 'stdio' | 'sse' | 'ws' | 'streamableHttp'

/** Settings for the URL an entry is served at; any of them may be top-level. */
export interface EndpointOptions {
  outputTransport?: Transport
  baseUrl?: string
  ssePath?: string
  messagePath?: string
  streamableHttpPath?: string
  cors?: true | string[]
  healthEndpoint?: string[]
  headers?: Record<string, string>
  oauth2Bearer?: string
  apiKey?: string[]
  apiKeyFile?: string
  stateful?: boolean
  sessionTimeout?: number
  protocolVersion?: string
}

/** What to run, or where to connect. */
export type ServerSource =
  | { kind: 'command'; command: string; args: string[] }
  | { kind: 'stdio'; stdio: string }
  | { kind: 'url'; url: string; type: 'sse' | 'streamableHttp' }

export interface InnerServer {
  name: string
  source: ServerSource
  env?: Record<string, string>
  cwd?: string
  headers?: Record<string, string>
  oauth2Bearer?: string
}

export interface Entry extends EndpointOptions {
  name: string
  /** Where it is served; `/<name>` unless the file sets `path`. */
  path: string
  /** One server, or the servers combined on this entry's URL. */
  server: Omit<InnerServer, 'name'> | { members: InnerServer[] }
}

export interface GatewaySettings {
  port?: number
  host?: string
  logLevel?: 'debug' | 'info' | 'none'
  logFormat?: 'text' | 'json'
  exitWithProcess?: number
  /** The gateway's own health endpoints, as `--healthEndpoint`. */
  healthEndpoint?: string[]
}

export interface Config {
  gateway: GatewaySettings
  defaults: EndpointOptions
  entries: Entry[]
}

export type Loaded =
  { config: Config; warnings: string[] } | { error: string; warnings: string[] }

const GATEWAY_KEYS = [
  'port',
  'host',
  'logLevel',
  'logFormat',
  'exitWithProcess',
] as const
const ENDPOINT_KEYS = [
  'outputTransport',
  'baseUrl',
  'ssePath',
  'messagePath',
  'streamableHttpPath',
  'cors',
  'healthEndpoint',
  'headers',
  'oauth2Bearer',
  'apiKey',
  'apiKeyFile',
  'stateful',
  'sessionTimeout',
  'protocolVersion',
] as const
const SOURCE_KEYS = [
  'command',
  'args',
  'stdio',
  'url',
  'type',
  'transportType',
] as const
const SERVER_KEYS = [...SOURCE_KEYS, 'env', 'cwd', 'disabled', 'enabled']

// Keys other clients keep in the same file, for themselves: approval prompts,
// their own timeouts, trust and visibility. They mean nothing to a gateway.
const CLIENT_ONLY_KEYS = new Set([
  'autoApprove',
  'alwaysAllow',
  'timeout',
  'trust',
  'alwaysLoad',
  'disabledTools',
  'includeTools',
  'excludeTools',
  'envFile',
  'headersHelper',
  'oauth',
  'description',
  'globalShortcut',
])

const TOP_KEYS = new Set<string>([
  '$schema',
  'mcpServers',
  ...GATEWAY_KEYS,
  ...ENDPOINT_KEYS,
])
const ENTRY_KEYS = new Set<string>([
  ...SERVER_KEYS,
  ...ENDPOINT_KEYS,
  'path',
  'mcpServers',
])
const INNER_KEYS = new Set<string>([...SERVER_KEYS, 'headers', 'oauth2Bearer'])

const TRANSPORTS: readonly string[] = ['stdio', 'sse', 'ws', 'streamableHttp']
const URL_TYPES: Record<string, 'sse' | 'streamableHttp'> = {
  sse: 'sse',
  http: 'streamableHttp',
  'streamable-http': 'streamableHttp',
  streamableHttp: 'streamableHttp',
  streamable_http: 'streamableHttp',
}

class ConfigError extends Error {}

/**
 * Reads and checks a config file. Every error names the file, line, column and
 * key path; nothing in the file is ignored without a warning.
 */
export function loadConfig(
  file: string,
  text: string,
  env: Record<string, string | undefined>,
): Loaded {
  const warnings: string[] = []
  const at = (offset: number) => {
    const before = text.slice(0, offset).split('\n')
    return `${file}:${before.length}:${before[before.length - 1].length + 1}`
  }
  try {
    const errors: ParseError[] = []
    const root = parseTree(text, errors, {
      allowTrailingComma: true,
      disallowComments: false,
    })
    if (errors.length > 0)
      return {
        error: `Error: ${at(errors[0].offset)}: ${describeParseError(errors[0].error)}`,
        warnings,
      }
    // A text with no value in it at all (empty, or only comments) is a "value
    // expected" error above, so there is always a tree here.
    const tree = root!
    const fail = (path: (string | number)[], message: string): never => {
      // Every path a check fails on is one it read from this tree.
      const node = findNodeAtLocation(tree, path)!
      const where = node.parent?.type === 'property' ? node.parent : node
      throw new ConfigError(
        `${at(where.offset)}: ${pathText(path)}${path.length ? ': ' : ''}${message}`,
      )
    }
    if (tree.type !== 'object')
      fail([], 'The file must hold an object with "mcpServers"')
    return { config: readConfig(tree, env, fail, warnings), warnings }
  } catch (err) {
    // A ConfigError says where and why. Anything else, such as a file nested
    // deeper than the parser or reader can recurse, is still reported as an
    // error rather than crashing the gateway.
    return {
      error: `Error: ${(err as Error).message}`,
      warnings,
    }
  }
}

type Fail = (path: (string | number)[], message: string) => never

function readConfig(
  root: Node,
  env: Record<string, string | undefined>,
  fail: Fail,
  warnings: string[],
): Config {
  const raw = expand(getNodeValue(root), [], env, fail)
  checkKeys(raw, [], TOP_KEYS, fail, warnings)
  const gateway: GatewaySettings = {}
  if ('port' in raw) gateway.port = integer(raw.port, ['port'], fail, 0)
  if ('host' in raw) gateway.host = text(raw.host, ['host'], fail)
  if ('logLevel' in raw)
    gateway.logLevel = oneOf(
      raw.logLevel,
      ['logLevel'],
      ['debug', 'info', 'none'],
      fail,
    ) as GatewaySettings['logLevel']
  if ('logFormat' in raw)
    gateway.logFormat = oneOf(
      raw.logFormat,
      ['logFormat'],
      ['text', 'json'],
      fail,
    ) as GatewaySettings['logFormat']
  if ('exitWithProcess' in raw)
    gateway.exitWithProcess = integer(
      raw.exitWithProcess,
      ['exitWithProcess'],
      fail,
      2,
    )
  if ('healthEndpoint' in raw)
    gateway.healthEndpoint = paths(raw.healthEndpoint, ['healthEndpoint'], fail)
  const defaults = endpointOptions(raw, [], fail, ['healthEndpoint'])
  if (!('mcpServers' in raw))
    fail([], 'Add "mcpServers" with at least one server')
  const servers = object(raw.mcpServers, ['mcpServers'], fail)
  const entries: Entry[] = []
  for (const [name, value] of Object.entries(servers)) {
    const entry = readEntry(name, value, fail, warnings)
    if (entry) entries.push(entry)
  }
  if (entries.length === 0)
    fail(['mcpServers'], 'There is no enabled server to serve')
  const byPath = new Map<string, string>()
  // Never empty here, so not a `for` loop with a zero-iteration case.
  entries.forEach((entry) => {
    const other = byPath.get(entry.path)
    if (other !== undefined)
      fail(
        ['mcpServers', entry.name],
        `${entryText(entry.name)} and ${entryText(other)} both use the path ${entry.path}`,
      )
    byPath.set(entry.path, entry.name)
  })
  const localOnStdio = entries.find(
    (entry) =>
      !('members' in entry.server) &&
      entry.server.source.kind !== 'url' &&
      effectiveTransport(entry, defaults) === 'stdio',
  )
  if (localOnStdio)
    fail(
      ['mcpServers', localOnStdio.name],
      'A local server already speaks stdio. Serve it with "outputTransport": "sse", "ws" or "streamableHttp"',
    )
  const onStdio = entries.filter(
    (entry) => effectiveTransport(entry, defaults) === 'stdio',
  )
  if (onStdio.length > 1)
    fail(
      ['mcpServers', onStdio[1].name],
      `${entryText(onStdio[0].name)} and ${entryText(onStdio[1].name)} would both use stdio output, which carries one entry. Combine them under one entry's "mcpServers", or set "outputTransport" on one`,
    )
  return { gateway, defaults, entries }
}

function readEntry(
  name: string,
  value: unknown,
  fail: Fail,
  warnings: string[],
): Entry | undefined {
  const path = ['mcpServers', name]
  const raw = object(value, path, fail)
  checkKeys(raw, path, ENTRY_KEYS, fail, warnings)
  if (!isEnabled(raw, path, fail)) return undefined
  const options = endpointOptions(raw, path, fail, [])
  const urlPath =
    'path' in raw
      ? routePath(raw.path, [...path, 'path'], fail)
      : defaultPath(name, path, fail)
  if ('mcpServers' in raw) {
    const extra = SERVER_KEYS.filter(
      (key) => key in raw && key !== 'disabled' && key !== 'enabled',
    )
    if (extra.length > 0)
      fail(
        [...path, extra[0]],
        `An entry with its own "mcpServers" combines them; "${extra[0]}" belongs on one of those servers`,
      )
    const members = Object.entries(
      object(raw.mcpServers, [...path, 'mcpServers'], fail),
    )
      .map(([memberName, member]) =>
        readInner(memberName, member, [...path, 'mcpServers'], fail, warnings),
      )
      .filter((member): member is InnerServer => member !== undefined)
    if (members.length === 0)
      fail([...path, 'mcpServers'], 'There is no enabled server to combine')
    return { name, path: urlPath, ...options, server: { members } }
  }
  const server = readServer(raw, path, fail, false)
  return { name, path: urlPath, ...options, server }
}

function readInner(
  name: string,
  value: unknown,
  parent: (string | number)[],
  fail: Fail,
  warnings: string[],
): InnerServer | undefined {
  const path = [...parent, name]
  const raw = object(value, path, fail)
  if ('mcpServers' in raw)
    fail(
      [...path, 'mcpServers'],
      'Combining goes one level deep only; a combined server cannot combine others',
    )
  const urlSetting = Object.keys(raw).find(
    (key) =>
      (ENDPOINT_KEYS as readonly string[]).includes(key) &&
      !INNER_KEYS.has(key),
  )
  if (urlSetting !== undefined)
    fail(
      [...path, urlSetting],
      `"${urlSetting}" is a setting for the URL. Put it on ${pathText(parent.slice(0, -1))} instead`,
    )
  if ('path' in raw)
    fail(
      [...path, 'path'],
      `A combined server is served at ${pathText(parent.slice(0, -1))}'s URL; "path" belongs there`,
    )
  checkKeys(raw, path, INNER_KEYS, fail, warnings)
  if (!isEnabled(raw, path, fail)) return undefined
  return { name, ...readServer(raw, path, fail, true) }
}

// `inner` is a server combined on another entry's URL. An entry's own
// `headers` and `oauth2Bearer` are read with its endpoint options and mean what
// `--header` means for it, as on the command line: sent to a remote server, or
// added to the responses of a local one. A combined server has no responses of
// its own, so for it they only go to a remote server.
function readServer(
  raw: Record<string, unknown>,
  path: (string | number)[],
  fail: Fail,
  inner: boolean,
): Omit<InnerServer, 'name'> {
  const given = (['command', 'stdio', 'url'] as const).filter(
    (key) => key in raw,
  )
  if (given.length === 0)
    fail(
      path,
      'Says nothing to run. Add "command" (with "args"), "stdio", or "url"',
    )
  if (given.length > 1)
    fail(
      [...path, given[1]],
      `Has both "${given[0]}" and "${given[1]}". An entry runs one server (command, stdio or url) or combines several (its own "mcpServers")`,
    )
  let source: ServerSource
  if (given[0] === 'url') {
    if ('type' in raw && 'transportType' in raw)
      fail(
        [...path, 'transportType'],
        'Has both "type" and "transportType", which mean the same. Keep "type"',
      )
    const type = 'type' in raw ? raw.type : raw.transportType
    const typeKey = 'type' in raw ? 'type' : 'transportType'
    if (type === undefined)
      fail(
        [...path, 'url'],
        'Add "type": "streamableHttp" or "sse", so it is clear how to reach this server',
      )
    const known = URL_TYPES[text(type, [...path, typeKey], fail)]
    if (!known)
      fail(
        [...path, typeKey],
        `"${type}" is not a remote transport. Use "streamableHttp" or "sse"`,
      )
    ;(['args', 'env', 'cwd'] as const).forEach((key) => {
      if (key in raw)
        fail(
          [...path, key],
          `"${key}" goes with a local server ("command" or "stdio"), not "url"`,
        )
    })
    source = {
      kind: 'url',
      url: urlText(raw.url, [...path, 'url'], fail),
      type: known,
    }
  } else {
    if ('type' in raw && raw.type !== 'stdio')
      fail(
        [...path, 'type'],
        `"type": ${JSON.stringify(raw.type)} goes with "url". A local server is "type": "stdio", or no type`,
      )
    if (given[0] === 'stdio') {
      if ('args' in raw)
        fail(
          [...path, 'args'],
          '"args" goes with "command". "stdio" is one shell command line',
        )
      source = {
        kind: 'stdio',
        stdio: text(raw.stdio, [...path, 'stdio'], fail),
      }
    } else {
      source = {
        kind: 'command',
        command: text(raw.command, [...path, 'command'], fail),
        args:
          'args' in raw
            ? strings(
                raw.args,
                [...path, 'args'],
                fail,
                'a list of strings',
                true,
              )
            : [],
      }
    }
    ;(['headers', 'oauth2Bearer'] as const).forEach((key) => {
      if (inner && key in raw)
        fail(
          [...path, key],
          `"${key}" is sent to a remote server, so it goes with "url"`,
        )
    })
  }
  const server: Omit<InnerServer, 'name'> = { source }
  if ('env' in raw) server.env = stringMap(raw.env, [...path, 'env'], fail)
  if ('cwd' in raw) server.cwd = text(raw.cwd, [...path, 'cwd'], fail)
  if (inner && 'headers' in raw)
    server.headers = stringMap(raw.headers, [...path, 'headers'], fail)
  if (inner && 'oauth2Bearer' in raw)
    server.oauth2Bearer = text(
      raw.oauth2Bearer,
      [...path, 'oauth2Bearer'],
      fail,
    )
  return server
}

function endpointOptions(
  raw: Record<string, unknown>,
  path: (string | number)[],
  fail: Fail,
  skip: string[],
): EndpointOptions {
  const at = (key: string) => [...path, key]
  const options: EndpointOptions = {}
  const has = (key: string) => key in raw && !skip.includes(key)
  if (has('outputTransport'))
    options.outputTransport = oneOf(
      raw.outputTransport,
      at('outputTransport'),
      TRANSPORTS,
      fail,
    ) as Transport
  if (has('baseUrl')) options.baseUrl = text(raw.baseUrl, at('baseUrl'), fail)
  ;(['ssePath', 'messagePath', 'streamableHttpPath'] as const).forEach(
    (key) => {
      if (has(key)) options[key] = routePath(raw[key], at(key), fail)
    },
  )
  if (has('cors')) {
    if (raw.cors === true) options.cors = true
    else if (raw.cors !== false)
      options.cors = strings(
        raw.cors,
        at('cors'),
        fail,
        'true, false, or a list of origins',
      )
  }
  if (has('healthEndpoint'))
    options.healthEndpoint = paths(
      raw.healthEndpoint,
      at('healthEndpoint'),
      fail,
    )
  if (has('apiKey'))
    options.apiKey =
      typeof raw.apiKey === 'string'
        ? [text(raw.apiKey, at('apiKey'), fail)]
        : strings(raw.apiKey, at('apiKey'), fail, 'a key or a list of keys')
  if (has('apiKeyFile'))
    options.apiKeyFile = text(raw.apiKeyFile, at('apiKeyFile'), fail)
  if (has('stateful'))
    options.stateful = boolean(raw.stateful, at('stateful'), fail)
  if (has('sessionTimeout'))
    options.sessionTimeout = integer(
      raw.sessionTimeout,
      at('sessionTimeout'),
      fail,
      1,
    )
  if (has('protocolVersion'))
    options.protocolVersion = text(
      raw.protocolVersion,
      at('protocolVersion'),
      fail,
    )
  if (has('headers'))
    options.headers = stringMap(raw.headers, at('headers'), fail)
  if (has('oauth2Bearer'))
    options.oauth2Bearer = text(raw.oauth2Bearer, at('oauth2Bearer'), fail)
  return options
}

/** The output transport an entry ends up with: its own, the file's, the CLI's. */
export function effectiveTransport(
  entry: Entry,
  defaults: EndpointOptions,
): Transport {
  const set = entry.outputTransport ?? defaults.outputTransport
  if (set) return set
  // As on the command line: a remote server is bridged to stdio, and a local
  // one is served over SSE.
  if ('members' in entry.server)
    return entry.server.members.every((m) => m.source.kind === 'url')
      ? 'stdio'
      : 'sse'
  return entry.server.source.kind === 'url' ? 'stdio' : 'sse'
}

function isEnabled(
  raw: Record<string, unknown>,
  path: (string | number)[],
  fail: Fail,
) {
  const disabled =
    'disabled' in raw && boolean(raw.disabled, [...path, 'disabled'], fail)
  const enabled =
    !('enabled' in raw) || boolean(raw.enabled, [...path, 'enabled'], fail)
  return enabled && !disabled
}

function checkKeys(
  raw: Record<string, unknown>,
  path: (string | number)[],
  allowed: Set<string>,
  fail: Fail,
  warnings: string[],
) {
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue
    if (CLIENT_ONLY_KEYS.has(key)) {
      warnings.push(
        `Ignored ${pathText([...path, key])}: it is a setting for the client app, not the gateway`,
      )
      delete raw[key]
      continue
    }
    const hint = closest(key, allowed)
    fail(
      [...path, key],
      `Unknown key "${key}".${hint ? ` Did you mean "${hint}"?` : ''}`,
    )
  }
}

// ${VAR}, ${VAR:-default} and ${env:VAR} in string values, after parsing, so
// a comment can never be expanded. `stdio` is a shell command line: the shell
// expands $VAR there itself, from the environment the child inherits.
// A server's own keys sit at odd depths (mcpServers.<name>.stdio, and
// mcpServers.<name>.mcpServers.<member>.stdio); at even depths are the names
// inside `env` and `headers`, where "stdio" is just a name and is expanded.
function expand(
  value: unknown,
  path: (string | number)[],
  env: Record<string, string | undefined>,
  fail: Fail,
): any {
  if (typeof value === 'string')
    return path.length % 2 === 1 && path[path.length - 1] === 'stdio'
      ? value
      : expandString(value, path, env, fail)
  if (Array.isArray(value))
    return value.map((item, i) => expand(item, [...path, i], env, fail))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        expand(item, [...path, key], env, fail),
      ]),
    )
  return value
}

function expandString(
  value: string,
  path: (string | number)[],
  env: Record<string, string | undefined>,
  fail: Fail,
) {
  return value.replace(
    /\$\$|\$\{(?:env:)?([^}:]*)(?::-([^}]*))?\}|\$\{/g,
    (match, name: string | undefined, fallback: string | undefined) => {
      if (match === '$$') return '$'
      // `name` is captured by every match but `$$` and a bare `${`.
      if (match === '${' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name!))
        fail(
          path,
          `"${match}" is not a variable. Write \${NAME} or \${NAME:-default}, and $$ for a literal $`,
        )
      const set = env[name!]
      if (set !== undefined && set !== '') return set
      if (fallback !== undefined) return fallback
      return fail(
        path,
        `\${${name}} is not set. Set it, or give a default: \${${name}:-…}`,
      )
    },
  )
}

const defaultPath = (name: string, path: (string | number)[], fail: Fail) =>
  /^[A-Za-z0-9_-]+$/.test(name)
    ? `/${name}`
    : fail(
        path,
        `"${name}" can't be used in a URL. Add "path", e.g. "path": "/${slug(name)}"`,
      )

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'server'

function routePath(value: unknown, path: (string | number)[], fail: Fail) {
  const raw = text(value, path, fail)
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  // Trailing slashes go, so "/" and "//" are both the root, never "".
  const trimmed = withSlash.replace(/\/+$/, '') || '/'
  if (/\/\/|[?#\s]/.test(trimmed)) fail(path, `"${raw}" is not a usable path`)
  return trimmed
}

const paths = (value: unknown, path: (string | number)[], fail: Fail) =>
  (typeof value === 'string' ? [value] : strings(value, path, fail)).map(
    (item, i) =>
      routePath(item, typeof value === 'string' ? path : [...path, i], fail),
  )

function object(value: unknown, path: (string | number)[], fail: Fail) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(path, 'Expected an object')
  return value as Record<string, unknown>
}

function text(value: unknown, path: (string | number)[], fail: Fail): string {
  if (typeof value !== 'string' || value.trim() === '')
    fail(path, 'Expected a non-empty string')
  return value as string
}

function urlText(value: unknown, path: (string | number)[], fail: Fail) {
  const raw = text(value, path, fail)
  try {
    const url = new URL(raw)
    if (url.protocol === 'http:' || url.protocol === 'https:') return raw
  } catch {
    // Reported below.
  }
  return fail(path, `"${raw}" is not an http(s) URL`)
}

function boolean(value: unknown, path: (string | number)[], fail: Fail) {
  if (typeof value !== 'boolean') fail(path, 'Expected true or false')
  return value as boolean
}

function integer(
  value: unknown,
  path: (string | number)[],
  fail: Fail,
  min: number,
) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min)
    fail(path, `Expected a whole number of at least ${min}`)
  return value as number
}

function oneOf(
  value: unknown,
  path: (string | number)[],
  choices: readonly string[],
  fail: Fail,
) {
  if (typeof value !== 'string' || !choices.includes(value))
    fail(path, `Expected one of ${choices.map((c) => `"${c}"`).join(', ')}`)
  return value as string
}

// `emptyAllowed` is for command arguments, where "" is a real argument.
function strings(
  value: unknown,
  path: (string | number)[],
  fail: Fail,
  expected = 'a list of strings',
  emptyAllowed = false,
) {
  if (
    !Array.isArray(value) ||
    value.some(
      (item) =>
        typeof item !== 'string' || (!emptyAllowed && item.trim() === ''),
    )
  )
    fail(path, `Expected ${expected}`)
  return value as string[]
}

function stringMap(value: unknown, path: (string | number)[], fail: Fail) {
  const raw = object(value, path, fail)
  for (const [key, item] of Object.entries(raw))
    if (typeof item !== 'string')
      fail([...path, key], 'Expected a string value')
  return raw as Record<string, string>
}

function describeParseError(code: number) {
  const name = printParseErrorCode(code)
  return name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
}

const pathText = (path: (string | number)[]) =>
  path
    .map((part, i) =>
      typeof part === 'number'
        ? `[${part}]`
        : /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)
          ? `${i === 0 ? '' : '.'}${part}`
          : `${i === 0 ? '' : '.'}"${part}"`,
    )
    .join('')

const entryText = (name: string) => pathText(['mcpServers', name])

/** The allowed key nearest to `key`, if it is plausibly a typo of it. */
function closest(key: string, allowed: Set<string>) {
  let best: string | undefined
  let bestDistance = Infinity
  allowed.forEach((candidate) => {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase())
    if (distance < bestDistance) {
      best = candidate
      bestDistance = distance
    }
  })
  return bestDistance <= Math.max(2, Math.floor(key.length / 4))
    ? best
    : undefined
}

function editDistance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]
    row[0] = i
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]
      row[j] = Math.min(
        row[j] + 1,
        row[j - 1] + 1,
        previous + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
      previous = current
    }
  }
  return row[b.length]
}
