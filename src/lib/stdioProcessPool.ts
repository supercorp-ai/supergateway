import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Logger } from '../types.js'

export class StdioChildProcessPool {
  private stdioCmd: string
  private maxConcurrency: number
  private activeProcesses: Set<ChildProcessWithoutNullStreams> = new Set()
  private idleProcesses: ChildProcessWithoutNullStreams[] = []
  private queue: Array<() => void> = []
  private logger: Logger

  constructor({
    stdioCmd,
    minConcurrency,
    maxConcurrency,
    logger,
  }: {
    stdioCmd: string
    maxConcurrency: number
    minConcurrency: number
    logger: Logger
  }) {
    this.stdioCmd = stdioCmd
    this.maxConcurrency = maxConcurrency
    this.logger = logger

    for (let i = 0; i < Math.min(minConcurrency, maxConcurrency); i++) {
      this.idleProcesses.push(this.createChild())
    }
  }

  async acquire(): Promise<ChildProcessWithoutNullStreams> {
    if (this.idleProcesses.length > 0) {
      const child = this.idleProcesses.shift()!
      this.activeProcesses.add(child)

      return child
    }

    if (this.activeProcesses.size < this.maxConcurrency) {
      const child = this.createChild()
      this.activeProcesses.add(child)
      return child
    }

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
      child.stdout.removeAllListeners('data')
      child.stderr.removeAllListeners('data')
      child.removeAllListeners('exit')

      if (this.queue.length > 0) {
        const next = this.queue.shift()!
        next()
      }
    } else {
      this.logger.error('Cannot release exited process')
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
