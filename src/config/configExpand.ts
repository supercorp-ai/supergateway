import type { Fail } from './configTypes.js'

// ${VAR}, ${VAR:-default} and ${env:VAR} in string values, after parsing, so
// a comment can never be expanded. `stdio` is a shell command line: the shell
// expands $VAR there itself, from the environment the child inherits.
export function expand(
  value: unknown,
  path: (string | number)[],
  env: Record<string, string | undefined>,
  fail: Fail,
): any {
  if (typeof value === 'string')
    return isShellCommandLine(path)
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

// A server's own keys sit at odd depths (mcpServers.<name>.stdio, and
// mcpServers.<name>.mcpServers.<member>.stdio); at even depths are the names
// inside `env` and `headers`, where "stdio" is just a name and is expanded.
const isShellCommandLine = (path: (string | number)[]) =>
  path.length % 2 === 1 && path[path.length - 1] === 'stdio'

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
