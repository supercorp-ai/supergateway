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
type ProcessQuery = (
  command: string,
  args: string[],
  options: {
    encoding: 'utf8'
    timeout: number
    stdio: ['ignore', 'pipe', 'pipe']
  },
) => string

export function descendantsOf(
  pid: number,
  {
    platform = process.platform,
    query = (command, args, options) => execFileSync(command, args, options),
  }: { platform?: NodeJS.Platform; query?: ProcessQuery } = {},
): number[] {
  // Do not turn an unavailable process table into a successful zero-child check.
  const options = {
    encoding: 'utf8' as const,
    // PowerShell/CIM cold startup exceeded 10 seconds on a hosted Windows runner.
    timeout: platform === 'win32' ? 30000 : 10000,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
  }
  const table =
    platform === 'win32'
      ? query(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
            "$ErrorActionPreference = 'Stop'; Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.ParentProcessId }",
          ],
          options,
        )
      : query('ps', ['-eo', 'pid=,ppid='], options)
  assert.ok(table.trim(), 'Process enumeration returned an empty table')
  const children = new Map<number, number[]>()
  for (const line of table.trim().split(/\r?\n/)) {
    assert.match(line.trim(), /^\d+\s+\d+$/, 'Invalid process table row')
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child === 0) continue // Windows System Idle Process is its own parent.
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found = new Set<number>()
  const walk = (root: number) => {
    for (const child of children.get(root) ?? []) {
      // A snapshot can contain recycled PIDs; never loop through a parent cycle.
      if (child === pid || found.has(child)) continue
      found.add(child)
      walk(child)
    }
  }
  walk(pid)
  return [...found]
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
