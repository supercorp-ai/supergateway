import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
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

export function processInfo(pid: number) {
  try {
    const row = execFileSync(
      'ps',
      ['-o', 'ppid=,pgid=,stat=', '-p', String(pid)],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\s+/)
    return {
      parent: Number(row[0]),
      group: Number(row[1]),
      alive: row.length === 3 && !row[2].startsWith('Z'),
    }
  } catch (error) {
    if ((error as { status?: number }).status === 1)
      return { parent: 0, group: 0, alive: false }
    throw error
  }
}
export async function stopped(pid: number) {
  const deadline = Date.now() + 7000
  while (processInfo(pid).alive && Date.now() < deadline) await delay(25)
  assert.equal(
    processInfo(pid).alive,
    false,
    `owned peer ${pid} survived cleanup`,
  )
}
export function reapAfter(
  t: import('node:test').TestContext,
  pid: number,
  group: number,
) {
  // Runs AFTER the assertions; also cleans detached groups when a mutant fails.
  t.after(() => {
    for (const target of [-group, pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  })
}
