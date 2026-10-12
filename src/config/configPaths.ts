import type { Fail, Entry } from './configTypes.js'
import { text, strings, entryText } from './configValues.js'

// No two entries may be served at the same path.
export function checkPaths(entries: Entry[], fail: Fail) {
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
}

export const defaultPath = (
  name: string,
  path: (string | number)[],
  fail: Fail,
) =>
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

export function routePath(
  value: unknown,
  path: (string | number)[],
  fail: Fail,
) {
  const raw = text(value, path, fail)
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`
  // Trailing slashes go, so "/" and "//" are both the root, never "".
  const trimmed = withSlash.replace(/\/+$/, '') || '/'
  if (/\/\/|[?#\s]/.test(trimmed)) fail(path, `"${raw}" is not a usable path`)
  return trimmed
}

export function paths(value: unknown, path: (string | number)[], fail: Fail) {
  if (typeof value === 'string') return [routePath(value, path, fail)]
  return strings(value, path, fail).map((item, i) =>
    routePath(item, [...path, i], fail),
  )
}
