import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { resolve } from 'node:path'

// A failed battery cancels the resource load too, rather than leaving it running
// until the six-hour deadline. Give each command time to perform its cleanup.
export function createSoakCommandGroup({ root, events, env }) {
  const active = new Set()
  const abort = new AbortController()
  function cancel(reason) {
    if (!abort.signal.aborted) {
      abort.abort(reason)
      events({ phase: 'cancel-commands', reason })
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
    events({ phase: 'end-command', name, ...result, timedOut })
    if (result.code !== 0 || timedOut) {
      cancel(`${name} failed`)
      throw Error(`${name} failed; inspect ${root}/${name}.log`)
    }
  }
  return {
    run,
    cancel,
    signal: abort.signal,
    get failed() {
      return abort.signal.aborted
    },
  }
}
