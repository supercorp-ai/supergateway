import type { Logger } from '../types.js'
import type { OwnedStdioTransport } from './ownedStdioTransport.js'

/**
 * How long a backend waits for the next round of its operation. A human may
 * be answering an elicitation, so this is minutes; it is also the longest an
 * abandoned operation can hold a process.
 */
export const CONTINUATION_TIMEOUT = 300_000
/** Retained backends are bounded; the oldest is released to admit a newer one. */
export const RETAINED_CHILD_LIMIT = 64

/**
 * Backends kept alive between the HTTP exchanges of one multi-round operation.
 *
 * A modern request normally owns a fresh backend that exits with its HTTP
 * exchange. A backend that answers `input_required` may sign its
 * `requestState` with a key that lives only as long as that process, so the
 * client's next round has to reach the same process. The exact opaque token is
 * the only correlation the wire offers: the client echoes it byte for byte and
 * the gateway never decodes it.
 */
export class RetainedChildren {
  private readonly entries = new Map<
    string,
    { child: OwnedStdioTransport; timer: NodeJS.Timeout }
  >()
  // Exchanges that observed a minted token but have not finished parking its
  // child yet. A continuation arriving in that window waits instead of
  // starting a fresh backend that cannot verify the state.
  private readonly parking = new Map<
    string,
    { count: number; done: Promise<void>; settle: () => void }
  >()
  private closed = false

  constructor(
    private readonly options: {
      idleMs: number
      limit: number
      logger: Logger
    },
  ) {}

  get size(): number {
    return this.entries.size
  }

  /**
   * Announces that an exchange saw `token` minted and will keep or release its
   * child when it completes. The returned function records that completion.
   */
  reserve(token: string): () => void {
    let entry = this.parking.get(token)
    if (!entry) {
      let settle!: () => void
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      entry = { count: 0, done, settle }
      this.parking.set(token, entry)
    }
    const reservation = entry
    reservation.count++
    let settled = false
    return () => {
      if (settled) return
      settled = true
      if (--reservation.count === 0) {
        this.parking.delete(token)
        reservation.settle()
      }
    }
  }

  /** Keeps the backend that minted `token` until its continuation or expiry. */
  keep(token: string, child: OwnedStdioTransport): void {
    if (this.closed) {
      void this.discard(child)
      return
    }
    if (this.entries.has(token)) {
      // Two live backends minted the same token, so it does not identify a
      // process. Release both: a fresh backend serves either continuation,
      // exactly as it would without retention.
      this.release(token)
      void this.discard(child)
      return
    }
    if (this.entries.size >= this.options.limit) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.release(oldest)
    }
    // Output between rounds has no HTTP response to reach. Exit or failure
    // ends the retention; the eventual continuation then starts afresh.
    child.onmessage = () => {}
    child.onerror = () => this.release(token)
    child.onclose = () => this.release(token)
    const timer = setTimeout(() => this.release(token), this.options.idleMs)
    this.entries.set(token, { child, timer })
  }

  /** Reclaims the backend that minted `token`, if it is still retained. */
  async take(token: string): Promise<OwnedStdioTransport | undefined> {
    const parking = this.parking.get(token)
    if (parking) await parking.done
    const entry = this.entries.get(token)
    if (!entry) return undefined
    clearTimeout(entry.timer)
    this.entries.delete(token)
    entry.child.onmessage = undefined
    entry.child.onerror = undefined
    entry.child.onclose = undefined
    return entry.child
  }

  async close(): Promise<void> {
    this.closed = true
    const children = [...this.entries.values()].map((entry) => {
      clearTimeout(entry.timer)
      return entry.child
    })
    this.entries.clear()
    await Promise.all(children.map((child) => this.discard(child)))
  }

  private release(token: string): void {
    const entry = this.entries.get(token)
    if (!entry) return
    clearTimeout(entry.timer)
    this.entries.delete(token)
    void this.discard(entry.child)
  }

  private discard(child: OwnedStdioTransport): Promise<void> {
    return child.close().catch((error) => {
      this.options.logger.error('Failed to close retained MCP child:', error)
    })
  }
}
