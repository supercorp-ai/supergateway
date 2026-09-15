import type { TestContext } from 'node:test'

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
  return <T extends { kill: () => unknown }>(child: T): T & { pid: number } => {
    const pid = nextPid++
    children.set(pid, child)
    return Object.assign(child, { pid })
  }
}
