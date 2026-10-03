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

/**
 * The MCP server a listening gateway serves: a command it starts for each
 * session, or a remote server it opens a session with for each; and, with
 * --toolPrefix or --tools, the tools a client sees of it.
 */
export type ServerSource = (
  | { stdioCmd: ChildCommand; upstream?: undefined }
  | { upstream: RemoteServer; stdioCmd?: undefined }
) & { toolNames?: ToolNames }

/** The server's lines in a gateway's startup listing. */
export function announceServer(logger: Logger, source: ServerSource) {
  if (!source.upstream) {
    logger.info(`  - stdio: ${describeCommand(source.stdioCmd)}`)
  } else {
    logger.info(
      `  - ${source.upstream.type}: ${redactUrl(source.upstream.url)}`,
    )
    logger.info(
      `  - Upstream headers: ${describeHeaders(source.upstream.headers)}`,
    )
  }
  source.toolNames
    ?.describe()
    .forEach((setting) => logger.info(`  - ${setting}`))
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
  const start = source.upstream
    ? upstreamPeer(source.upstream, children, logger, label)
    : spawnedPeer(spawn, source.stdioCmd, children)
  return source.toolNames ? toolNamesPeer(start, source.toolNames) : start
}

const spawnedPeer = (
  spawn: Spawn,
  command: ChildCommand,
  children: OwnedChildProcesses,
) => {
  const child = spawnCommand(spawn, command, children.spawnOptions)
  return processPeer(child, children.own(child))
}
