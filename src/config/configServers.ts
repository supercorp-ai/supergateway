import type { Fail, InnerServer, ServerSource } from './configTypes.js'
import { stringMap, text, urlText, strings, boolean } from './configValues.js'
import { ENDPOINT_READERS, URL_TYPES } from './configKeys.js'

// `inner` is a server combined on another entry's URL. An entry's own
// `headers` and `oauth2Bearer` are read with its endpoint options and mean what
// `--header` means for it, as on the command line: sent to a remote server, or
// added to the responses of a local one. A combined server has no responses of
// its own, so for it they only go to a remote server.
export function readServer(
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
  const source =
    given[0] === 'url'
      ? urlSource(raw, path, fail)
      : localSource(raw, path, fail, inner)
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
  if (inner && 'toolPrefix' in raw)
    server.toolPrefix = ENDPOINT_READERS.toolPrefix(
      raw.toolPrefix,
      [...path, 'toolPrefix'],
      fail,
    )
  if (inner && 'tools' in raw)
    server.tools = ENDPOINT_READERS.tools(raw.tools, [...path, 'tools'], fail)
  return server
}

// A remote server: its `url`, and the `type` (or `transportType`) that says
// how to reach it.
function urlSource(
  raw: Record<string, unknown>,
  path: (string | number)[],
  fail: Fail,
): ServerSource {
  if ('type' in raw && 'transportType' in raw)
    fail(
      [...path, 'transportType'],
      'Has both "type" and "transportType", which mean the same. Keep "type"',
    )
  const typeKey = 'type' in raw ? 'type' : 'transportType'
  const type = raw[typeKey]
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
  return {
    kind: 'url',
    url: urlText(raw.url, [...path, 'url'], fail),
    type: known,
  }
}

// A local server: one shell command line (`stdio`), or a `command` and its
// `args`.
function localSource(
  raw: Record<string, unknown>,
  path: (string | number)[],
  fail: Fail,
  inner: boolean,
): ServerSource {
  if ('type' in raw && raw.type !== 'stdio')
    fail(
      [...path, 'type'],
      `"type": ${JSON.stringify(raw.type)} goes with "url". A local server is "type": "stdio", or no type`,
    )
  const source =
    'stdio' in raw
      ? stdioSource(raw, path, fail)
      : commandSource(raw, path, fail)
  ;(['headers', 'oauth2Bearer'] as const).forEach((key) => {
    if (inner && key in raw)
      fail(
        [...path, key],
        `"${key}" is sent to a remote server, so it goes with "url"`,
      )
  })
  return source
}

function stdioSource(
  raw: Record<string, unknown>,
  path: (string | number)[],
  fail: Fail,
): ServerSource {
  if ('args' in raw)
    fail(
      [...path, 'args'],
      '"args" goes with "command". "stdio" is one shell command line',
    )
  return { kind: 'stdio', stdio: text(raw.stdio, [...path, 'stdio'], fail) }
}

function commandSource(
  raw: Record<string, unknown>,
  path: (string | number)[],
  fail: Fail,
): ServerSource {
  return {
    kind: 'command',
    command: text(raw.command, [...path, 'command'], fail),
    args:
      'args' in raw
        ? strings(raw.args, [...path, 'args'], fail, 'a list of strings', true)
        : [],
  }
}

export function isEnabled(
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
