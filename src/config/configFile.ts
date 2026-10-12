import type {
  Transport,
  EndpointOptions,
  ServerSource,
  InnerServer,
  Entry,
  GatewaySettings,
  Config,
  Loaded,
  Fail,
} from './configTypes.js'
import {
  text,
  describeParseError,
  pathText,
  object,
  entryText,
} from './configValues.js'
import {
  type ParseError,
  parseTree,
  findNodeAtLocation,
  type Node,
  getNodeValue,
} from 'jsonc-parser'
import { expand } from './configExpand.js'
import {
  checkKeys,
  TOP_KEYS,
  readSettings,
  GATEWAY_READERS,
  ENDPOINT_READERS,
  ENTRY_KEYS,
  RUN_KEYS,
  URL_ONLY_KEYS,
  INNER_KEYS,
} from './configKeys.js'
import { checkPaths, routePath, defaultPath } from './configPaths.js'
import { isEnabled, readServer } from './configServers.js'

export {
  type Transport,
  type EndpointOptions,
  type ServerSource,
  type InnerServer,
  type Entry,
  type GatewaySettings,
  type Config,
  type Loaded,
} from './configTypes.js'

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

function readConfig(
  root: Node,
  env: Record<string, string | undefined>,
  fail: Fail,
  warnings: string[],
): Config {
  const raw = expand(getNodeValue(root), [], env, fail)
  checkKeys(raw, [], TOP_KEYS, fail, warnings)
  const gateway = readSettings(raw, [], GATEWAY_READERS, fail)
  // At the top level, `healthEndpoint` is the gateway's own, read above.
  const defaults = readSettings(raw, [], ENDPOINT_READERS, fail, [
    'healthEndpoint',
  ])
  if (!('mcpServers' in raw))
    fail([], 'Add "mcpServers" with at least one server')
  const entries = Object.entries(object(raw.mcpServers, ['mcpServers'], fail))
    .map(([name, value]) => readEntry(name, value, fail, warnings))
    .filter((entry): entry is Entry => entry !== undefined)
  if (entries.length === 0)
    fail(['mcpServers'], 'There is no enabled server to serve')
  checkPaths(entries, fail)
  checkStdioOutput(entries, defaults, fail)
  return { gateway, defaults, entries }
}

// Stdio output carries one entry, and only a remote one: a local server
// already speaks stdio.
function checkStdioOutput(
  entries: Entry[],
  defaults: EndpointOptions,
  fail: Fail,
) {
  const localOnStdio = entries.find(
    (entry) =>
      isLocal(entry) && effectiveTransport(entry, defaults) === 'stdio',
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
}

// An entry that runs one server of its own, rather than reaching a remote one
// or combining several.
const isLocal = (entry: Entry) =>
  !('members' in entry.server) && entry.server.source.kind !== 'url'

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
  const options = readSettings(raw, path, ENDPOINT_READERS, fail)
  const urlPath =
    'path' in raw
      ? routePath(raw.path, [...path, 'path'], fail)
      : defaultPath(name, path, fail)
  const server =
    'mcpServers' in raw
      ? readCombined(raw, path, fail, warnings)
      : readServer(raw, path, fail, false)
  return { name, path: urlPath, ...options, server }
}

// An entry's own "mcpServers", combined on its URL.
function readCombined(
  raw: Record<string, unknown>,
  path: (string | number)[],
  fail: Fail,
  warnings: string[],
): { members: InnerServer[] } {
  const extra = RUN_KEYS.filter((key) => key in raw)
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
  return { members }
}

function readInner(
  name: string,
  value: unknown,
  parent: (string | number)[],
  fail: Fail,
  warnings: string[],
): InnerServer | undefined {
  const path = [...parent, name]
  const entry = pathText(parent.slice(0, -1))
  const raw = object(value, path, fail)
  if ('mcpServers' in raw)
    fail(
      [...path, 'mcpServers'],
      'Combining goes one level deep only; a combined server cannot combine others',
    )
  const urlSetting = Object.keys(raw).find((key) => URL_ONLY_KEYS.has(key))
  if (urlSetting !== undefined)
    fail(
      [...path, urlSetting],
      `"${urlSetting}" is a setting for the URL. Put it on ${entry} instead`,
    )
  if ('path' in raw)
    fail(
      [...path, 'path'],
      `A combined server is served at ${entry}'s URL; "path" belongs there`,
    )
  checkKeys(raw, path, INNER_KEYS, fail, warnings)
  if (!isEnabled(raw, path, fail)) return undefined
  return { name, ...readServer(raw, path, fail, true) }
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
  const servers =
    'members' in entry.server ? entry.server.members : [entry.server]
  return servers.every((server) => server.source.kind === 'url')
    ? 'stdio'
    : 'sse'
}
