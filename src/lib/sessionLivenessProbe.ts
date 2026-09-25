import { randomUUID } from 'node:crypto'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../types.js'
import { setLongTimeout, type LongTimeout } from './longTimeout.js'

// A GET socket can remain open at a reverse proxy after its client vanishes.
// A protocol ping crosses that proxy and requires an answer from the client.
// Only clients that have answered before can be reaped on later misses;
// unknown clients keep their existing long-lived GET behavior.
export class SessionLivenessProbe {
  private readonly idPrefix = `supergateway-ping:${randomUUID()}:`
  private nextId = 0
  private timer?: NodeJS.Timeout
  private graceTimer?: LongTimeout
  private active = false
  private closed = false
  private revision = 0
  private missed = 0
  private activeRequests = 0
  // A reply proves this logical session's client supports pings even if its
  // GET stream later reconnects.
  private answered = false
  private staleEligible = false
  private firstProbe = false

  constructor(
    private readonly intervalMs: number,
    private readonly replyTimeoutMs: number,
    private readonly staleAfterMs: number,
    private readonly send: (id: string) => Promise<void>,
    private readonly stale: () => void,
    private readonly logger: Logger,
  ) {}

  // Only the first GET owns the probe. A rejected concurrent GET must not stop
  // the monitor attached to the real stream when its response finishes.
  start(): boolean {
    if (this.active || this.closed) return false
    this.active = true
    this.missed = 0
    // Establish ping support soon after each GET opens. A client may disappear
    // before the regular interval (five minutes with the default timeout).
    this.firstProbe = true
    this.resetGrace()
    if (!this.activeRequests) this.schedule()
    return true
  }

  stop(): void {
    this.active = false
    this.revision++
    clearTimeout(this.timer)
    this.graceTimer?.clear()
    this.timer = undefined
    this.graceTimer = undefined
  }

  close(): void {
    this.closed = true
    this.stop()
  }

  // Any client POST is proof of life. It also forgives a missed ping, so a
  // temporarily sleeping client with a working request path is not reaped.
  activity(): void {
    if (!this.active) return
    this.missed = 0
    this.resetGrace()
    this.revision++
    clearTimeout(this.timer)
    if (!this.activeRequests) this.schedule()
  }

  requestStarted(): void {
    this.activeRequests++
    this.activity()
  }

  requestFinished(): void {
    if (this.activeRequests) this.activeRequests--
    this.activity()
  }

  accept(message: JSONRPCMessage): boolean {
    if (
      !('id' in message) ||
      'method' in message ||
      typeof message.id !== 'string' ||
      !message.id.startsWith(this.idPrefix)
    )
      return false
    // An error reply still proves that a client received and answered the ping.
    this.answered = true
    this.activity()
    return true
  }

  private schedule(): void {
    this.revision++
    clearTimeout(this.timer)
    const revision = this.revision
    this.timer = setTimeout(
      () => {
        if (this.active && this.revision === revision) this.probe()
      },
      this.firstProbe ? Math.min(this.intervalMs, 5_000) : this.intervalMs,
    )
    this.timer.unref()
  }

  private resetGrace(): void {
    this.graceTimer?.clear()
    this.staleEligible = false
    this.graceTimer = setLongTimeout(() => {
      this.staleEligible = true
    }, this.staleAfterMs)
    this.graceTimer.unref()
  }

  private probe(): void {
    this.firstProbe = false
    const id = `${this.idPrefix}${++this.nextId}`
    const revision = ++this.revision
    this.logger.info('Sending session liveness ping')
    void this.send(id)
      .then(() => {
        if (!this.active || this.revision !== revision) return
        this.timer = setTimeout(() => this.miss(revision), this.replyTimeoutMs)
        this.timer.unref()
      })
      .catch((error) => {
        if (!this.active || this.revision !== revision) return
        this.logger.error('Failed to send session liveness ping:', error)
        this.miss(revision)
      })
  }

  private miss(revision: number): void {
    if (!this.active || this.revision !== revision) return
    if (++this.missed < 2) {
      this.probe()
      return
    }
    if (!this.answered) {
      this.logger.info(
        'Client has not answered liveness pings; preserving session for compatibility',
      )
      this.stop()
      return
    }
    if (!this.staleEligible) {
      this.schedule()
      return
    }
    this.logger.info('Closing session after two unanswered liveness pings')
    this.stop()
    this.stale()
  }
}
