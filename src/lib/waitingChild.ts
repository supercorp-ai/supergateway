import type { ChildOwner } from './peer.js'
import type { ChildLink } from './childLink.js'
import type { Logger } from '../types.js'

/**
 * A child parked for a retry, as its owner: it keeps what the child says until
 * someone takes the child over, and stops the child if nobody does in time.
 */
export class WaitingChild implements ChildOwner {
  private readonly held: [any, string][] = []
  private settled = false
  // With nobody to deliver to, the child is not read past what it has
  // already sent: the rest waits in its pipe, as it does for a client that
  // is behind, so waiting costs no memory however much it writes.
  private resume!: () => void
  private readonly unread = new Promise<void>(
    (resolve) => (this.resume = resolve),
  )
  private readonly timer: NodeJS.Timeout

  constructor(
    readonly link: ChildLink,
    private readonly label: string,
    private readonly logger: Logger,
    windowMs: number,
    // Takes it off the handoff's list of waiting children.
    private readonly leave: () => void,
  ) {
    this.timer = setTimeout(
      () => this.end('no client took it over'),
      windowMs,
    ).unref()
  }

  message(message: any, line: string) {
    this.held.push([message, line])
  }

  nonJson(line: string) {
    this.logger.error(`${this.label}: waiting server wrote non-JSON: ${line}`)
  }

  stderr(text: string) {
    this.logger.error(`${this.label}: waiting server stderr: ${text}`)
  }

  failure(kind: 'process' | 'stdin' | 'upstream', err: Error) {
    this.end(`${kind} failure: ${err.message}`)
  }

  exit(code: number | null, signal: NodeJS.Signals | null) {
    this.end(`it exited, code=${code}, signal=${signal}`)
  }

  output() {
    return this.unread
  }

  /** Stops it waiting, unless it already has; false then. */
  settle(): boolean {
    if (this.settled) return false
    this.settled = true
    clearTimeout(this.timer)
    this.leave()
    return true
  }

  /**
   * Replays everything the child said while waiting to its new owner, and
   * reads it again.
   */
  replay() {
    this.held.forEach(([message, line]) =>
      this.link.owner.message(message, line),
    )
    this.resume()
  }

  // Every way a waiting child ends goes through here, once: the window
  // running out, or the child exiting (as it does when that stops it) or
  // failing.
  private end(reason: string) {
    if (!this.settle()) return
    this.logger.info(`${this.label}: stopping the waiting server: ${reason}`)
    this.resume()
    void this.link.stop()
  }
}
