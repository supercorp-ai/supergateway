import type { Logger } from '../types.js'

type Kill = (pid: number, signal: number) => unknown

// The largest PID process.kill accepts: it rejects anything that is not a
// 32-bit integer with ERR_INVALID_ARG_TYPE, which the watcher would otherwise
// count as "alive" forever. No platform hands out PIDs anywhere near it.
const maxPid = 0x7fffffff

/**
 * Whether a process is still running, asked with signal 0, which checks
 * without delivering anything.
 *
 * ESRCH is the only answer that means gone. EPERM means it exists but belongs
 * to another user, so it is running; reading that as "gone" (as
 * vscode-languageserver does) would shut down the moment a launcher runs as a
 * different user. Anything else is not evidence that it exited.
 */
export function probeProcess(
  pid: number,
  kill: Kill = process.kill,
): 'alive' | 'gone' | { unexpected: unknown } {
  try {
    kill(pid, 0)
    return 'alive'
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return 'gone'
    if (code === 'EPERM') return 'alive'
    return { unexpected: error }
  }
}

/**
 * The PID `--exitWithProcess` names, or why it is unusable.
 *
 * Absent means no watching at all. Present but empty (`--exitWithProcess` with
 * no value) is an error rather than "off": the launcher asked to be watched.
 */
export function exitWithProcessOf(
  argv: { exitWithProcess?: number },
  {
    kill = process.kill,
    ownPid = process.pid,
  }: { kill?: Kill; ownPid?: number } = {},
): { pid?: number } | { error: string } {
  if (!('exitWithProcess' in argv)) return {}
  // Typed as a number, but yargs gives NaN for `abc`, undefined for a flag
  // with no value, and an array for a repeated flag; isInteger rejects all
  // three.
  const pid = argv.exitWithProcess as number
  if (!Number.isInteger(pid) || pid < 0 || pid > maxPid)
    return {
      error: `Error: --exitWithProcess must be a positive integer PID, received: ${String(pid)}`,
    }
  // kill(0, 0) asks about this process's own group, and PID 1 is init, which
  // never exits; either would silently watch nothing.
  if (pid <= 1)
    return {
      error: `Error: --exitWithProcess: PID ${pid} cannot be watched (0 is the process group, 1 is init); pass the launcher's PID`,
    }
  if (pid === ownPid)
    return {
      error: `Error: --exitWithProcess: ${pid} is supergateway's own PID; pass the launcher's PID`,
    }
  if (probeProcess(pid, kill) === 'gone')
    return {
      error: `Error: --exitWithProcess: process ${pid} is not running. In a container, the host's PIDs are not visible; pass a PID from inside the container`,
    }
  return { pid }
}

/**
 * Calls `onExit` once, when process `pid` has exited.
 *
 * Polled, because no portable API reports the exit of a process that is not
 * this one's child. The timer is unref'd: it must never be the thing keeping
 * the gateway alive.
 */
export function watchProcess(
  pid: number,
  {
    onExit,
    logger,
    kill = process.kill,
    intervalMs = 1000,
  }: {
    onExit: () => void
    logger: Logger
    kill?: Kill
    intervalMs?: number
  },
) {
  let reported = false
  const timer = setInterval(() => {
    const state = probeProcess(pid, kill)
    if (state === 'gone') {
      clearInterval(timer)
      onExit()
      return
    }
    // Once, so a persistent oddity does not write a line every second.
    if (state === 'alive' || reported) return
    reported = true
    logger.error(
      `Could not check process ${pid}; treating it as running:`,
      state.unexpected,
    )
  }, intervalMs)
  timer.unref()
  return timer
}
