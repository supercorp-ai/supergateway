import type { Config, EndpointOptions, InnerServer } from './configFile.js'
import { redactQuery } from '../lib/urlCredentials.js'
import { isSensitiveHeader } from '../lib/headers.js'

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
    // Every value: a secret goes by any name here (DATABASE_URL, PGPASS).
    if (s.env)
      out.env = Object.fromEntries(
        Object.keys(s.env).map((name) => [name, '<redacted>']),
      )
    if (s.cwd) out.cwd = s.cwd
    if (s.headers) out.headers = redactMap(s.headers)
    if (s.oauth2Bearer) out.oauth2Bearer = '<redacted>'
    if (s.toolPrefix) out.toolPrefix = s.toolPrefix
    if (s.tools) out.tools = s.tools
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
  return { type: source.type, url: redactQuery(source.url) }
}

const redactMap = (map: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(map).map(([name, value]) => [
      name,
      isSensitiveHeader(name) ? '<redacted>' : value,
    ]),
  )
