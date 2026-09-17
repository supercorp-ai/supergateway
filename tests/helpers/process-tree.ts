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
            "$ErrorActionPreference = 'Stop'; Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().Ticks.ToString() } else { '0' }) }",
          ],
          options,
        )
      : query('ps', ['-eo', 'pid=,ppid='], options)
  assert.ok(table.trim(), 'Process enumeration returned an empty table')
  const children = new Map<number, number[]>()
  const created = new Map<number, bigint>()
  for (const line of table.trim().split(/\r?\n/)) {
    assert.match(
      line.trim(),
      platform === 'win32' ? /^\d+\s+\d+\s+\d+$/ : /^\d+\s+\d+$/,
      'Invalid process table row',
    )
    const [childText, parentText, ticks] = line.trim().split(/\s+/)
    const child = Number(childText)
    const parent = Number(parentText)
    if (platform === 'win32') created.set(child, BigInt(ticks))
    if (child === 0) continue // Windows System Idle Process is its own parent.
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found = new Set<number>()
  const walk = (root: number) => {
    for (const child of children.get(root) ?? []) {
      // A snapshot can contain recycled PIDs; never loop through a parent cycle.
      if (child === pid || found.has(child)) continue
      if (platform === 'win32' && created.has(root)) {
        const parentCreated = created.get(root)!
        const childCreated = created.get(child)!
        assert.ok(
          parentCreated > 0n && childCreated > 0n,
          'Process creation time unavailable for ancestry check',
        )
        // ParentProcessId survives the creator's exit on Windows. Reject edges
        // to a newer process that reused its PID, including the entire false subtree.
        if (childCreated < parentCreated) continue
      }
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
