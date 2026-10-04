import type { ChildProcessWithoutNullStreams } from 'child_process'
import type { Logger } from '../types.js'

// A wrapper's exit does not imply its descendants exited. Keep ownership until
// the process group disappears, or until the bounded escalation has run.
//
// macOS refuses (EPERM) to signal a group whose processes have all exited but
// are not reaped yet, which is the moment after a child is stopped. Such a
// group is gone once Node reaps it, so a refusal counts as "still there" and
// is reported only when it has lasted UNREAPED_GRACE_MS: then it is a group
// the gateway may not signal, a child that changed user for one.
const UNREAPED_GRACE_MS = 1000

export class OwnedChildProcesses {
  private readonly children = new Set<() => Promise<void>>()
  closing = false
  readonly spawnOptions = {
    shell: true,
    detached: process.platform !== 'win32',
  }

  constructor(private readonly logger: Logger) {}

  own(child: ChildProcessWithoutNullStreams): () => Promise<void> {
    const grouped = this.spawnOptions.detached
    const pid = child.pid
    let stopped: Promise<void> | undefined
    let refusedSince: number | undefined
    const signal = (name: NodeJS.Signals | 0): boolean => {
      // An asynchronous spawn failure has no PID and owns no process group.
      if (pid === undefined) return false
      try {
        if (grouped) process.kill(-pid, name)
        else if (!child.kill(name)) return false
        return true
      } catch (error) {
        const { code } = error as NodeJS.ErrnoException
        if (code === 'ESRCH') return false
        if (code === 'EPERM') {
          refusedSince ??= Date.now()
          if (Date.now() - refusedSince < UNREAPED_GRACE_MS) return true
        }
        this.logger.error(`Failed to signal child ${pid} with ${name}:`, error)
        return false
      }
    }
    const terminate = async () => {
      if (signal('SIGTERM')) {
        const deadline = Date.now() + 5000
        while (signal(0)) {
          if (Date.now() >= deadline) {
            signal('SIGKILL')
            break
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 25))
        }
      }
      this.children.delete(stop)
    }
    const stop = () => (stopped ??= terminate())
    this.children.add(stop)
    // Do not wait for 'close': a descendant may retain the wrapper's pipes.
    child.once('exit', () => {
      void stop()
    })
    return stop
  }

  /**
   * Owns something that is not a process, such as a session with a remote
   * server: `stop` runs once, at the latest when the gateway shuts down.
   */
  track(stop: () => Promise<void>): () => Promise<void> {
    let stopped: Promise<void> | undefined
    const once = () =>
      (stopped ??= stop().finally(() => this.children.delete(once)))
    this.children.add(once)
    return once
  }

  async close(): Promise<void> {
    this.closing = true
    // A request already awaiting setup can still acquire a child during shutdown.
    while (this.children.size) {
      await Promise.all([...this.children].map((stop) => stop()))
    }
  }
}
