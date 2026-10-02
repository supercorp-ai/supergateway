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

/**
 * The MCP server a listening gateway serves: a command it starts for each
 * session, or a remote server it opens a session with for each.
 */
export type ServerSource =
  | { stdioCmd: ChildCommand; upstream?: undefined }
  | { upstream: RemoteServer; stdioCmd?: undefined }

/** The server's lines in a gateway's startup listing. */
export function announceServer(logger: Logger, source: ServerSource) {
  if (!source.upstream) {
    logger.info(`  - stdio: ${describeCommand(source.stdioCmd)}`)
    return
  }
  logger.info(`  - ${source.upstream.type}: ${redactUrl(source.upstream.url)}`)
  logger.info(
    `  - Upstream headers: ${describeHeaders(source.upstream.headers)}`,
  )
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
  if (source.upstream)
    return upstreamPeer(source.upstream, children, logger, label)
  const child = spawnCommand(spawn, source.stdioCmd, children.spawnOptions)
  return processPeer(child, children.own(child))
}
