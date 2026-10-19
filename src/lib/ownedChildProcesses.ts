import type { ChildProcessWithoutNullStreams } from 'child_process'
import childProcess from 'node:child_process'
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

// taskkill can outlast any budget on a stalled host: a 4.2.1-rc.2 soak saw
// two of them killed at five seconds while the Windows runner stood still,
// and the two servers they were ending ran for the remaining four and a half
// hours. A failed attempt is retried while the shell still runs; its PID is
// still its own until Node has seen it exit.
const TASKKILL_TIMEOUT_MS = 15000
const TASKKILL_ATTEMPTS = 3
const TASKKILL_RETRY_MS = 250

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
    // Signals the child's process group. Only POSIX has one: on Windows the
    // tree is ended by taskkill (terminate, below).
    const signal = (name: NodeJS.Signals | 0): boolean => {
      // An asynchronous spawn failure has no PID and owns no process group.
      if (pid === undefined) return false
      try {
        process.kill(-pid, name)
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
      if (!grouped) {
        // Killing cmd.exe alone leaves its stdio server running. Terminate the
        // tree while the shell is still alive, before sending any direct signal.
        // Once it has exited, its tree cannot be found by its PID, and the PID
        // may already be another process's: taskkill /T would end that one.
        const running = () => child.exitCode == null && child.signalCode == null
        if (pid !== undefined)
          for (let attempt = 1; running(); attempt++) {
            if (await this.endTree(pid)) break
            if (attempt === TASKKILL_ATTEMPTS) {
              this.logger.error(
                `Could not end server tree ${pid} in ${TASKKILL_ATTEMPTS} attempts; it may still be running`,
              )
              break
            }
            await new Promise((resolve) =>
              setTimeout(resolve, TASKKILL_RETRY_MS),
            )
          }
        this.children.delete(stop)
        return
      }
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

  /** One taskkill of server `pid`'s tree: whether it is over. */
  private endTree(pid: number) {
    return new Promise<boolean>((resolve) => {
      childProcess.execFile(
        'taskkill.exe',
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, timeout: TASKKILL_TIMEOUT_MS },
        (error, stdout) => {
          // taskkill returns 128 when the process has already exited.
          const failed = error != null && error.code !== 128
          if (failed)
            this.logger.error(`Failed to terminate child tree ${pid}:`, error)
          this.reportEnded(pid, String(stdout))
          resolve(!failed)
        },
      )
    })
  }

  /**
   * What taskkill ended for the tree of server `pid`, one line per stop: each
   * process as `PID<parent`. A process whose parent is neither that server
   * nor another process taskkill ended with it was not in its tree. Windows
   * reuses a process ID quickly, and taskkill lists a tree before it ends it,
   * so under heavy churn it can end a process that took a freed ID: that is
   * logged as an error, naming the process.
   */
  private reportEnded(pid: number, stdout: string) {
    const ended = [
      ...stdout.matchAll(/PID (\d+) \(child process of PID (\d+)\)/g),
    ].map(([, process, parent]) => ({
      process: Number(process),
      parent: Number(parent),
    }))
    if (!ended.length) return
    this.logger.info(
      `Ended server tree ${pid}: ${ended.map(({ process, parent }) => `${process}<${parent}`).join(' ')}`,
    )
    const tree = new Set([pid, ...ended.map(({ process }) => process)])
    const outside = ended.filter(
      ({ process, parent }) => process !== pid && !tree.has(parent),
    )
    for (const { process, parent } of outside)
      this.logger.error(
        `Ending server tree ${pid} also ended process ${process}, whose parent ${parent} is outside it`,
      )
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
