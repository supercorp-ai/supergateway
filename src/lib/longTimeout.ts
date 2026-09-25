/**
 * The longest delay setTimeout honours. Node treats anything larger as 1 ms
 * (with a TimeoutOverflowWarning), so a 30-day session timeout used to expire
 * its session at once.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647

export interface LongTimeout {
  clear(): void
  unref(): LongTimeout
}

/** setTimeout for any delay: longer ones are chained in maximal steps. */
export function setLongTimeout(
  callback: () => void,
  delayMs: number,
): LongTimeout {
  let timer: NodeJS.Timeout
  let unrefed = false
  const arm = (remaining: number) => {
    timer = setTimeout(
      () => {
        if (remaining > MAX_TIMEOUT_MS) arm(remaining - MAX_TIMEOUT_MS)
        else callback()
      },
      Math.min(remaining, MAX_TIMEOUT_MS),
    )
    if (unrefed) timer.unref()
  }
  arm(delayMs)
  return {
    clear() {
      clearTimeout(timer)
    },
    unref() {
      unrefed = true
      timer.unref()
      return this
    },
  }
}
