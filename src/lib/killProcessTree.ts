import { ChildProcess } from 'child_process'
import { Logger } from '../types.js'

/**
 * Kill a spawned child and every process it may have forked.
 *
 * Children are spawned with `{ shell: true, detached: true }`, which makes the
 * direct child a process-group leader. Negative PID in `process.kill` targets
 * the whole group — so `npx` and its `node` grandchild die together, instead
 * of only the `/bin/sh -c` wrapper being signalled (which does not forward
 * signals to its -c command).
 *
 * Escalates to SIGKILL after a 5s grace period if anything is still running.
 */
export function killProcessTree(
  child: ChildProcess | null | undefined,
  logger: Logger,
): void {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return
  }

  const pid = child.pid
  if (pid === undefined) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
    return
  }

  try {
    process.kill(-pid, 'SIGTERM')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code !== 'ESRCH') {
      logger.error(`killProcessTree SIGTERM failed for pgid ${pid}`, err)
    }
    return
  }

  const timer = setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL')
      logger.error(`killProcessTree escalated to SIGKILL for pgid ${pid}`)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code !== 'ESRCH') {
        logger.error(`killProcessTree SIGKILL failed for pgid ${pid}`, err)
      }
    }
  }, 5000)
  timer.unref()

  child.once('exit', () => clearTimeout(timer))
}
