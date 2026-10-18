import type {
  Fail,
  GatewaySettings,
  EndpointOptions,
  Transport,
} from './configTypes.js'
import {
  integer,
  text,
  oneOf,
  strings,
  boolean,
  stringMap,
  pathText,
} from './configValues.js'
import { paths, routePath } from './configPaths.js'
import type { HealthCheck } from '../lib/serverHealth.js'

// How one setting's value is read and checked.
type Reader<T> = (value: unknown, path: (string | number)[], fail: Fail) => T
type Readers<T> = { [K in keyof T]-?: Reader<T[K]> }

// Settings are read, and so checked and printed, in the order listed here.
export const GATEWAY_READERS: Readers<GatewaySettings> = {
  port: (value, path, fail) => integer(value, path, fail, 0),
  host: text,
  logLevel: (value, path, fail) =>
    oneOf(
      value,
      path,
      ['debug', 'info', 'none'],
      fail,
    ) as GatewaySettings['logLevel'],
  logFormat: (value, path, fail) =>
    oneOf(value, path, ['text', 'json'], fail) as GatewaySettings['logFormat'],
  exitWithProcess: (value, path, fail) => integer(value, path, fail, 2),
  healthEndpoint: paths,
}

export const ENDPOINT_READERS: Readers<EndpointOptions> = {
  outputTransport: (value, path, fail) =>
    oneOf(value, path, TRANSPORTS, fail) as Transport,
  baseUrl: text,
  ssePath: routePath,
  messagePath: routePath,
  streamableHttpPath: routePath,
  cors: (value, path, fail) => {
    if (typeof value === 'boolean') return value
    return strings(value, path, fail, 'true, false, or a list of origins')
  },
  healthEndpoint: paths,
  healthCheck: (value, path, fail) =>
    oneOf(value, path, ['gateway', 'server'], fail) as HealthCheck,
  toolPrefix: text,
  // An empty list is a real choice: none of the server's tools.
  tools: (value, path, fail) =>
    strings(value, path, fail, 'a list of tool names'),
  // An empty list would lock nothing, as an empty --apiKey or key file would.
  apiKey: (value, path, fail) => {
    if (typeof value === 'string') return [text(value, path, fail)]
    const keys = strings(value, path, fail, 'a key or a list of keys')
    if (keys.length === 0)
      fail(
        path,
        'An empty list accepts no key, so the server would be open to anyone. Give at least one key, or leave "apiKey" out. To serve one server without a key, set "apiKey" on the servers that need one instead of at the top level',
      )
    return keys
  },
  apiKeyFile: text,
  stateful: boolean,
  sessionTimeout: (value, path, fail) => integer(value, path, fail, 1),
  protocolVersion: text,
  headers: stringMap,
  oauth2Bearer: text,
}

// The keys a file may set are the ones there is a reader for.
const GATEWAY_KEYS = Object.keys(GATEWAY_READERS)
const ENDPOINT_KEYS = Object.keys(ENDPOINT_READERS)
const SOURCE_KEYS = [
  'command',
  'args',
  'stdio',
  'url',
  'type',
  'transportType',
] as const
// The keys that say what a server runs, and how.
export const RUN_KEYS = [...SOURCE_KEYS, 'env', 'cwd']
const SERVER_KEYS = [...RUN_KEYS, 'disabled', 'enabled']

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

export const TOP_KEYS = new Set<string>([
  '$schema',
  'mcpServers',
  ...GATEWAY_KEYS,
  ...ENDPOINT_KEYS,
])
export const ENTRY_KEYS = new Set<string>([
  ...SERVER_KEYS,
  ...ENDPOINT_KEYS,
  'path',
  'mcpServers',
])
// A combined server has what is about the server itself: how to reach a
// remote one, and which of its tools are seen, under which names.
export const INNER_KEYS = new Set<string>([
  ...SERVER_KEYS,
  'headers',
  'oauth2Bearer',
  'toolPrefix',
  'tools',
])
// Settings for the URL an entry is served at, which a combined server, served
// at its entry's URL, can't have.
export const URL_ONLY_KEYS = new Set<string>(
  ENDPOINT_KEYS.filter((key) => !INNER_KEYS.has(key)),
)

const TRANSPORTS: readonly string[] = ['stdio', 'sse', 'ws', 'streamableHttp']
export const URL_TYPES: Record<string, 'sse' | 'streamableHttp'> = {
  sse: 'sse',
  http: 'streamableHttp',
  'streamable-http': 'streamableHttp',
  streamableHttp: 'streamableHttp',
  streamable_http: 'streamableHttp',
}

// The settings `readers` knows that `raw` holds, less those in `skip`.
export function readSettings<T>(
  raw: Record<string, unknown>,
  path: (string | number)[],
  readers: Readers<T>,
  fail: Fail,
  skip: string[] = [],
): T {
  const settings: Record<string, unknown> = {}
  // Never empty, so not a `for` loop with a zero-iteration case.
  Object.entries<Reader<unknown>>(readers).forEach(([key, read]) => {
    if (!(key in raw) || skip.includes(key)) return
    settings[key] = read(raw[key], [...path, key], fail)
  })
  return settings as T
}

export function checkKeys(
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
