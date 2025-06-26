import { Logger } from '../types.js'

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

    if (session.accessCount <= 0) {
      throw new Error(
        `Invalid access count ${session.accessCount} for session ${sessionId}`,
      )
    }

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
