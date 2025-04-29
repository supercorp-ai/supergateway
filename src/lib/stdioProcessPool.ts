import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Logger } from '../types.js'

export class StdioChildProcessPool {
  private maxConcurrency: number
  private activeProcesses: Set<ChildProcessWithoutNullStreams> = new Set()
  private idleProcesses: ChildProcessWithoutNullStreams[] = []
  private queue: Array<() => void> = []
  private logger: Logger

  constructor(
    private stdioCmd: string,
    maxConcurrency: number,
    logger: Logger,
    preFork: number = 0,
  ) {
    this.maxConcurrency = maxConcurrency
    this.logger = logger
    for (let i = 0; i < Math.min(preFork, maxConcurrency); i++) {
      this.idleProcesses.push(this.createChild())
    }
    logger.info(`PreForked ${preFork} child processes`)
  }

  async acquire(): Promise<ChildProcessWithoutNullStreams> {
    if (this.idleProcesses.length > 0) {
      const child = this.idleProcesses.shift()!
      this.activeProcesses.add(child)
      this.logger.info(
        `Reusing child process, active: ${this.activeProcesses.size}`,
      )
      return child
    }

    if (this.activeProcesses.size < this.maxConcurrency) {
      const child = this.createChild()
      this.activeProcesses.add(child)
      this.logger.info(
        `New child created, active: ${this.activeProcesses.size}`,
      )
      return child
    }

    this.logger.info(
      `Waiting for available process (${this.queue.length} queued)`,
    )
    return new Promise((resolve) => {
      this.queue.push(() => {
        const child = this.idleProcesses.shift() || this.createChild()
        this.activeProcesses.add(child)
        resolve(child)
      })
    })
  }

  release(child: ChildProcessWithoutNullStreams) {
    if (child.exitCode === null && !child.killed) {
      this.activeProcesses.delete(child)
      this.idleProcesses.push(child)
      this.logger.info(
        `Process released to pool, active: ${this.activeProcesses.size}, idle: ${this.idleProcesses.length}`,
      )

      child.stdout.removeAllListeners('data')
      child.stderr.removeAllListeners('data')
      child.removeAllListeners('exit')

      if (this.queue.length > 0) {
        const next = this.queue.shift()!
        next()
      }
    } else {
      this.logger.info('Cannot release exited process')
    }
  }

  private createChild(): ChildProcessWithoutNullStreams {
    const child = spawn(this.stdioCmd, { shell: true })

    child.stdin.on('error', (err) => {
      this.logger.error(`Child stdin error: ${err.message}`)
    })

    child.stderr.on('data', (data: Buffer) => {
      const errorOutput = data.toString('utf8').trim()
      this.logger.error(`Child stderr error: ${errorOutput}`)
    })

    child.on('exit', (code, signal) => {
      this.activeProcesses.delete(child)
      this.idleProcesses = this.idleProcesses.filter((p) => p !== child)
      this.logger.error(
        `Child exited, code=${code}, signal=${signal}; active: ${this.activeProcesses.size}`,
      )
      this.checkQueue()
    })

    child.on('error', (err) => {
      this.activeProcesses.delete(child)
      this.idleProcesses = this.idleProcesses.filter((p) => p !== child)
      this.logger.error(`Child error: ${err.message}`)
    })

    return child
  }

  private checkQueue() {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    }
  }
}
