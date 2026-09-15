import { Logger } from '../types.js'

/**
 * The invariant `dec()` relies on: a session held in the counting shape always
 * has a positive count.
 *
 * No ordering of the public operations can break it — `inc` stores 1 or n+1,
 * `dec` returns early on the pending-cleanup shape and replaces the entry once
 * it reaches zero, and `clear` only deletes — which is why the check never
 * fires in practice and a property test asserts as much.
 *
 * It is a function rather than an inline branch so that the guarantee is
 * testable on its own terms. "Throws when handed a non-positive count" is this
 * function's contract, and a unit test can exercise it directly; inline, the
 * only way to reach the throw would be to manufacture a state the class cannot
 * produce.
 */
export function assertPositiveAccessCount(
  accessCount: number,
  sessionId: string,
) {
  if (accessCount <= 0) {
    throw new Error(
      `Invalid access count ${accessCount} for session ${sessionId}`,
    )
  }
}

export class SessionAccessCounter {
  private sessions: Map<
    string,
    { accessCount: number } | { timeout: NodeJS.Timeout }
  > = new Map()

  constructor(
    public timeout: number,
    public cleanup: (sessionId: string) => unknown,
    public logger: Logger,
  ) {}

  inc(sessionId: string, reason: string) {
    this.logger.info(
      `SessionAccessCounter.inc() ${sessionId}, caused by ${reason}`,
    )

    const session = this.sessions.get(sessionId)

    if (!session) {
      // New session
      this.logger.info(
        `Session access count 0 -> 1 for ${sessionId} (new session)`,
      )
      this.sessions.set(sessionId, { accessCount: 1 })
      return
    }

    if ('timeout' in session) {
      // Clear pending cleanup and reactivate
      this.logger.info(
        `Session access count 0 -> 1, clearing cleanup timeout for ${sessionId}`,
      )
      clearTimeout(session.timeout)
      this.sessions.set(sessionId, { accessCount: 1 })
    } else {
      // Increment active session
      this.logger.info(
        `Session access count ${session.accessCount} -> ${session.accessCount + 1} for ${sessionId}`,
      )
      session.accessCount++
    }
  }

  dec(sessionId: string, reason: string) {
    this.logger.info(
      `SessionAccessCounter.dec() ${sessionId}, caused by ${reason}`,
    )

    const session = this.sessions.get(sessionId)

    if (!session) {
      this.logger.error(
        `Called dec() on non-existent session ${sessionId}, ignoring`,
      )
      return
    }

    if ('timeout' in session) {
      this.logger.error(
        `Called dec() on session ${sessionId} that is already pending cleanup, ignoring`,
      )
      return
    }

    assertPositiveAccessCount(session.accessCount, sessionId)

    session.accessCount--
    this.logger.info(
      `Session access count ${session.accessCount + 1} -> ${session.accessCount} for ${sessionId}`,
    )

    if (session.accessCount === 0) {
      this.logger.info(
        `Session access count reached 0, setting cleanup timeout for ${sessionId}`,
      )

      this.sessions.set(sessionId, {
        timeout: setTimeout(() => {
          this.logger.info(`Session ${sessionId} timed out, cleaning up`)
          this.sessions.delete(sessionId)
          this.cleanup(sessionId)
        }, this.timeout),
      })
    }
  }

  clear(sessionId: string, runCleanup: boolean, reason: string) {
    this.logger.info(
      `SessionAccessCounter.clear() ${sessionId}, caused by ${reason}`,
    )

    const session = this.sessions.get(sessionId)
    if (!session) {
      this.logger.info(`Attempted to clear non-existent session ${sessionId}`)
      return
    }

    // Clear any pending timeout
    if ('timeout' in session) {
      clearTimeout(session.timeout)
    }

    // Remove from tracking
    this.sessions.delete(sessionId)

    // Run cleanup if requested
    if (runCleanup) {
      this.cleanup(sessionId)
    }
  }
}
