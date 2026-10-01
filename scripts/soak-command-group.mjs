import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { resolve } from 'node:path'

// By default a failed battery cancels the resource load too, rather than
// leaving it running until the six-hour deadline. With `keepGoing` a failure is
// recorded and everything else runs on: a soak phase is hours of evidence, and
// one flaky command used to throw the rest of it away, and with it every later
// phase. The phase still fails at the end. Give each command time to perform
// its cleanup.
export function createSoakCommandGroup({
  root,
  events,
  env,
  keepGoing = false,
}) {
  const active = new Set()
  const failures = []
  const abort = new AbortController()
  // Why the group stopped, kept apart from what each command then did. A
  // cancelled runner SIGTERMs the whole tree, so every command still running
  // dies non-zero — reporting those as failures buried the one job that
  // actually failed among eleven that were merely cancelled.
  let cancelReason = null
  let external = false
  function cancel(reason, fromSignal = false) {
    if (!abort.signal.aborted) {
      cancelReason = reason
      external = fromSignal
      abort.abort(reason)
      events({ phase: 'cancel-commands', reason, external })
    }
    for (const stop of active) stop()
  }
  async function run(name, args, timeout, extra = {}) {
    if (abort.signal.aborted) throw Error('Soak already cancelled')
    const log = createWriteStream(resolve(root, `${name}.log`))
    const child = spawn(process.execPath, args, {
      env: { ...env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.pipe(log, { end: false })
    child.stderr.pipe(log, { end: false })
    events({ phase: 'start-command', name, pid: child.pid })
    let timedOut = false
    let hardTimer
    const stop = () => {
      if (hardTimer) return
      child.kill('SIGTERM')
      hardTimer = setTimeout(() => child.kill('SIGKILL'), 15000)
    }
    active.add(stop)
    const timer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeout)
    const result = await new Promise((ok) => {
      child.once('error', (error) => ok({ code: null, error: String(error) }))
      child.once('close', (code, signal) => ok({ code, signal }))
    })
    clearTimeout(timer)
    clearTimeout(hardTimer)
    active.delete(stop)
    await new Promise((ok) => log.end(ok))
    // Cancellation reaches a command only through `stop()`, so a non-zero exit
    // while the group is already cancelling is that kill landing, not a verdict
    // on the command. Timeouts stay failures: `stop()` fired for this command's
    // own sake, and the group was not cancelling before it did.
    const cancelled = abort.signal.aborted && !timedOut && result.code !== 0
    events({ phase: 'end-command', name, ...result, timedOut, cancelled })
    if (cancelled)
      throw Error(`${name} was cancelled before it finished (${cancelReason})`)
    if (result.code !== 0 || timedOut) {
      failures.push(name)
      if (!keepGoing) cancel(`${name} failed`)
      throw Error(`${name} failed; inspect ${root}/${name}.log`)
    }
  }
  return {
    run,
    cancel,
    signal: abort.signal,
    // Any command failed, or the group was cancelled.
    get failed() {
      return failures.length > 0 || abort.signal.aborted
    },
    // The group was cancelled: start nothing more.
    get stopped() {
      return abort.signal.aborted
    },
    // The commands that failed, in order.
    get failures() {
      return [...failures]
    },
    // True only when nothing under this soak failed and the runner stopped us.
    get cancelledExternally() {
      return abort.signal.aborted && external
    },
  }
}
