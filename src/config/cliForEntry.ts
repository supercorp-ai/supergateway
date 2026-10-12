import {
  type Config,
  type Entry,
  type EndpointOptions,
  effectiveTransport,
  type InnerServer,
} from './configFile.js'
import type { ChildCommand } from '../lib/childCommand.js'

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
): { args: string[]; command?: ChildCommand; members?: MemberServer[] } {
  const { gateway, defaults } = config
  const pick = <K extends keyof EndpointOptions>(key: K) =>
    entry[key] ?? defaults[key]
  const args: string[] = []
  const flag = (name: string, value: unknown) => {
    if (value !== undefined) args.push(`--${name}=${String(value)}`)
  }
  const { server } = entry
  // For a local or combined server the value is replaced, by `command` or
  // `members`; the flag only selects the mode.
  if ('members' in server) flag('stdio', entry.name)
  else if (server.source.kind === 'url')
    flag(server.source.type, server.source.url)
  else
    flag(
      'stdio',
      server.source.kind === 'stdio'
        ? server.source.stdio
        : server.source.command,
    )
  flag('port', gateway.port)
  flag('host', gateway.host)
  flag('logLevel', gateway.logLevel)
  flag('logFormat', gateway.logFormat)
  flag('exitWithProcess', gateway.exitWithProcess)
  // Combined servers have no command line to take a default from.
  flag(
    'outputTransport',
    'members' in server
      ? effectiveTransport(entry, defaults)
      : pick('outputTransport'),
  )
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
  flag('toolPrefix', pick('toolPrefix'))
  const tools = pick('tools')
  // A bare --tools is an empty list: none of the server's tools.
  if (tools?.length === 0) args.push('--tools')
  else for (const name of tools ?? []) flag('tools', name)
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
  return 'members' in server
    ? { args, members: server.members.map(memberServer) }
    : { args, command: childCommand(server) }
}

/** One of a combined entry's servers, as the gateway starts it. */
export interface MemberServer {
  name: string
  /** A local server's command. */
  command?: ChildCommand
  /** A remote server, and what the gateway sends it. */
  upstream?: {
    url: string
    type: 'sse' | 'streamableHttp'
    headers: Record<string, string>
  }
  toolPrefix?: string
  tools?: string[]
}

const memberServer = (member: InnerServer): MemberServer => ({
  name: member.name,
  command: childCommand(member),
  upstream:
    member.source.kind === 'url'
      ? {
          url: member.source.url,
          type: member.source.type,
          headers: {
            ...member.headers,
            ...(member.oauth2Bearer
              ? { Authorization: `Bearer ${member.oauth2Bearer}` }
              : {}),
          },
        }
      : undefined,
  toolPrefix: member.toolPrefix,
  tools: member.tools,
})

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
