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

// Win32_Process reports CreationDate in .NET ticks: 100ns units since year 1.
const ticksAtUnixEpoch = 621355968000000000n
// Date.now() and CIM CreationDate are both UTC wall clock on the same host, but
// they are not the same clock read. Err toward counting a process rather than
// dismissing one, so a real leak is never hidden by a rounding difference.
const clockTolerance = 2000n
const ticksFrom = (unixMs: number) =>
  (BigInt(Math.floor(unixMs)) - clockTolerance) * 10000n + ticksAtUnixEpoch

export function descendantsOf(
  pid: number,
  {
    platform = process.platform,
    query = (command, args, options) => execFileSync(command, args, options),
    since,
  }: {
    platform?: NodeJS.Platform
    query?: ProcessQuery
    // When the root was spawned, in unix ms. Windows keeps ParentProcessId after
    // a parent exits and recycles low PIDs hard, so once the root is gone from
    // the table there is nothing left to date its edges against and every stale
    // claimant is attributed to it — 128 of them in soak run 35305652456. Its
    // spawn time is the evidence that survives the root itself.
    since?: number
  } = {},
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
  // Deeper roots were reached by walking the table, so they are always in it.
  // Only the process we were asked about can be missing, which is exactly when
  // it has exited — and an exited ancestor can still have real living children.
  const rootCreated =
    created.get(pid) ?? (since === undefined ? undefined : ticksFrom(since))
  // An absent root has exited, and on Windows its ParentProcessId edges outlive
  // it while the PID gets recycled. Without a spawn time there is nothing left
  // to date them against, and the walk silently returns whoever holds the PID
  // now — 128 processes in soak run 35305652456, four in 35309815902. Refuse,
  // the way this file already refuses an unreadable table, rather than answer
  // with a number nobody can trust.
  // Only when something actually claims the absent root: a pid with no
  // claimants has no descendants on any reading, and refusing there would turn
  // an ordinary empty answer into an error.
  assert.ok(
    platform !== 'win32' ||
      rootCreated !== undefined ||
      (children.get(pid)?.length ?? 0) === 0,
    'Root creation time unavailable for ancestry check: pass `since` for a root that may have exited',
  )
  const walk = (root: number) => {
    for (const child of children.get(root) ?? []) {
      // A snapshot can contain recycled PIDs; never loop through a parent cycle.
      if (child === pid || found.has(child)) continue
      const rootTicks = root === pid ? rootCreated : created.get(root)
      if (platform === 'win32' && rootTicks !== undefined) {
        const parentCreated = rootTicks
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
