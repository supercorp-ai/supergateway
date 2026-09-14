import { execFileSync } from 'node:child_process'

/**
 * Live descendants of a process, by walking the ppid table.
 *
 * A gateway spawns its stdio child through `/bin/sh`, so on Linux the server is
 * a grandchild rather than a child; counting only direct children would miss
 * exactly the processes GW-015 is about.
 */
export function descendantsOf(pid: number): number[] {
  let table: string
  try {
    table = execFileSync('ps', ['-eo', 'pid=,ppid='], { encoding: 'utf8' })
  } catch {
    return [] // no ps: report nothing rather than fail a test for the wrong reason
  }
  const children = new Map<number, number[]>()
  for (const line of table.split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (!child || Number.isNaN(parent)) continue
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found: number[] = []
  const walk = (root: number) => {
    for (const child of children.get(root) ?? []) {
      found.push(child)
      walk(child)
    }
  }
  walk(pid)
  return found
}
