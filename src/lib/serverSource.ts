import type { Logger } from '../types.js'
import { processPeer, type StartPeer } from './childHandoff.js'
import {
  describeCommand,
  spawnCommand,
  type ChildCommand,
} from './childCommand.js'
import type { OwnedChildProcesses } from './ownedChildProcesses.js'
import { redactUrl } from './urlCredentials.js'
import { describeHeaders } from './headers.js'
import { upstreamPeer, type RemoteServer } from './upstreamPeer.js'
import { toolNamesPeer, type ToolNames } from './toolNames.js'
import { combinedPeer } from './combinedPeer.js'

/**
 * The MCP server a listening gateway serves: a command it starts for each
 * session, a remote server it opens a session with for each, or several of
 * either combined as one; and, with --toolPrefix or --tools, the tools a
 * client sees of it.
 */
export type ServerSource = (
  | { stdioCmd: ChildCommand; upstream?: undefined; combined?: undefined }
  | { upstream: RemoteServer; stdioCmd?: undefined; combined?: undefined }
  | { combined: CombinedServers; stdioCmd?: undefined; upstream?: undefined }
) & { toolNames?: ToolNames }

/** The servers combined on one entry's URL, in the order the config lists them. */
export interface CombinedServers {
  /** The entry's name. */
  name: string
  members: (ServerSource & { name: string })[]
  /** The name clashes already warned about, across the entry's sessions. */
  warned: Set<string>
}

/** The server's lines in a gateway's startup listing. */
export function announceServer(
  logger: Logger,
  source: ServerSource,
  member = '',
) {
  const line = (text: string) => logger.info(`  - ${member}${text}`)
  if (source.combined) {
    const { members } = source.combined
    line(`combines: ${members.map(({ name }) => name).join(', ')}`)
    members.forEach((server) =>
      announceServer(logger, server, `${server.name}: `),
    )
  } else if (source.upstream) {
    line(`${source.upstream.type}: ${redactUrl(source.upstream.url)}`)
    line(`Upstream headers: ${describeHeaders(source.upstream.headers)}`)
  } else line(`stdio: ${describeCommand(source.stdioCmd)}`)
  source.toolNames?.describe().forEach(line)
}

type Spawn = typeof import('child_process').spawn

/**
 * One session's server. `spawn` is the gateway's own, which tests replace per
 * test; a remote server is not spawned at all.
 */
export function startServer(
  spawn: Spawn,
  source: ServerSource,
  children: OwnedChildProcesses,
  logger: Logger,
  label: string,
): StartPeer {
  const start = serverPeer(spawn, source, children, logger, label)
  return source.toolNames ? toolNamesPeer(start, source.toolNames) : start
}

function serverPeer(
  spawn: Spawn,
  source: ServerSource,
  children: OwnedChildProcesses,
  logger: Logger,
  label: string,
): StartPeer {
  if (source.combined)
    return combinedPeer(
      source.combined.name,
      // Each is started when the session initializes, not before.
      source.combined.members.map((member) => ({
        name: member.name,
        start: () =>
          startServer(
            spawn,
            member,
            children,
            logger,
            `${label} ${member.name}`,
          ),
      })),
      logger,
      source.combined.warned,
    )
  if (source.upstream)
    return upstreamPeer(source.upstream, children, logger, label)
  const child = spawnCommand(spawn, source.stdioCmd, children.spawnOptions)
  return processPeer(child, children.own(child))
}
