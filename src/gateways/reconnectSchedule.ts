const FIRST_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 30_000

/**
 * When the next reconnect runs. After the upstream is lost, the first one waits
 * a second, and each failed one doubles the wait, up to half a minute. At most
 * one is pending at a time.
 */
export class ReconnectSchedule {
  private timer: NodeJS.Timeout | undefined
  private delay = FIRST_RECONNECT_DELAY_MS

  /** Run `reconnect` after the current wait, unless one is already pending. */
  schedule(reconnect: () => void) {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      reconnect()
    }, this.delay)
    this.timer.unref()
  }

  /** Drop the pending reconnect: a connection is starting anyway. */
  cancel() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** A reconnect failed: wait longer before the next. */
  backOff() {
    this.delay = Math.min(this.delay * 2, MAX_RECONNECT_DELAY_MS)
  }

  /** A connection succeeded: the next loss starts from the first wait again. */
  reset() {
    this.delay = FIRST_RECONNECT_DELAY_MS
  }
}
