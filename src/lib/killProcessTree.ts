import { type ChildProcess } from 'child_process'
import { type Logger } from '../types.js'

/**
 * Stop a shell-launched child and every process in its process group.
 *
 * Streamable-HTTP gateways spawn with `shell: true`; signalling the direct
 * `/bin/sh -c` child alone leaves the real stdio MCP server alive.  The
 * callers create a detached process group, which lets POSIX target that group
 * using the negative PID.
 */
export function killProcessTree(
  child: ChildProcess | undefined,
  logger: Logger,
): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) return

  const pid = child.pid
  if (pid === undefined || process.platform === 'win32') {
    try {
      child.kill('SIGTERM')
    } catch {
      // The process may already have exited.
    }
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      logger.error(`killProcessTree SIGTERM failed for pgid ${pid}`, error)
    }
    return
  }

  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
      logger.error(`killProcessTree escalated to SIGKILL for pgid ${pid}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        logger.error(`killProcessTree SIGKILL failed for pgid ${pid}`, error)
      }
    }
  }, 5000)
  timer.unref()
  child.once('exit', () => clearTimeout(timer))
}
