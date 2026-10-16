import type { TestContext } from 'node:test'
import childProcess from 'node:child_process'

// Windows has no process groups: the gateway ends a child's tree with
// `taskkill /PID <pid> /T /F`, which removes the simulated child as a signal
// does. A gateway module loaded by an earlier test in the file keeps that
// test's execFile, so taskkill answers from the children of the test running
// now. Anything else execFile is asked to run is not this boundary's.
let current = new Map<number, { kill: () => unknown }>()
const execFile = childProcess.execFile
const fakeExecFile = ((file: string, args: string[], ...rest: unknown[]) => {
  if (!/taskkill/i.test(file))
    return (execFile as (...a: unknown[]) => unknown)(file, args, ...rest)
  const callback = rest.at(-1) as (error: Error | null) => void
  const pid = Number(args[args.indexOf('/PID') + 1])
  const child = current.get(pid)
  if (child) {
    child.kill()
    current.delete(pid)
  }
  // taskkill answers 128 for a process that is not there.
  queueMicrotask(() =>
    callback(
      child ? null : Object.assign(new Error('not found'), { code: 128 }),
    ),
  )
}) as unknown as typeof childProcess.execFile

// OS boundary for component tests. Real process ownership stays in production;
// TERM removes this simulated group and its next signal-0 probe sees ESRCH.
export function observeChildSignals(t: TestContext) {
  const children = new Map<number, { kill: () => unknown }>()
  let nextPid = 2000000000
  t.mock.method(
    process,
    'kill',
    (pid: number, signal?: NodeJS.Signals | number) => {
      const child = children.get(Math.abs(pid))
      if (!child)
        throw Object.assign(new Error('No such process'), { code: 'ESRCH' })
      if (signal !== 0) {
        child.kill()
        children.delete(Math.abs(pid))
      }
      return true
    },
  )
  current = children
  t.mock.method(childProcess, 'execFile', fakeExecFile)
  const track = <T extends { kill: () => unknown }>(
    child: T,
  ): T & { pid: number } => {
    const pid = nextPid++
    children.set(pid, child)
    return Object.assign(child, { pid })
  }
  // For a test that replaces the whole child_process module: its execFile.
  return Object.assign(track, { execFile: fakeExecFile })
}
