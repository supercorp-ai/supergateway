import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { execFile, execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { requestTimeout } from './slow-host.js'

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

/**
 * A process-table read, with stalls retried. A query that timed out observed
 * nothing, which is not evidence about any process, and failing on it blames
 * whatever ran then: soak run 35395011603 lost a healthy campaign at cycle 32
 * when a protocol test died of `spawnSync powershell.exe ETIMEDOUT`, and
 * 4.2.1-rc.1's 25-hour soak lost its Windows scenarios lane two hours in to
 * one stalled resource sample. PowerShell cold-starts for every query on
 * Windows, thousands of chances per lane to be unlucky. A stall can also last:
 * hour 20 of 4.2.1-rc.3's soak lost two Windows lanes on separate runners in
 * the same minute, each to two 30-second timeouts in a row. So a stall is
 * retried up to STALL_ATTEMPTS reads, about two minutes, before it is
 * believed, and the last timeout still throws: an unreadable table must never
 * pass as a clean one.
 */
const STALL_ATTEMPTS = 4
function retried<T>(read: () => T): T {
  for (let attempt = 1; ; attempt++) {
    try {
      return read()
    } catch (error) {
      const timedOut =
        (error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT' ||
        /ETIMEDOUT/.test(String((error as Error)?.message ?? ''))
      if (!timedOut || attempt === STALL_ATTEMPTS) throw error
    }
  }
}

/** A PowerShell command's output, with stalls retried (see retried). */
function powershell(command: string): string {
  return retried(() =>
    execFileSync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
    ),
  )
}

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
  const read = () =>
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
  const table = retried(read)
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

/**
 * The live processes whose command line contains `marker`, each as
 * "<pid> <command line>". It throws when the process table cannot be read:
 * an unreadable table must never pass for "nothing left running", which is
 * how a `ps ... || true` hid every Windows leak behind an empty list.
 */
export function commandLinesMatching(marker: string): string[] {
  const table =
    process.platform === 'win32'
      ? powershell(
          "$ErrorActionPreference = 'Stop'; Get-CimInstance -ClassName Win32_Process -Property ProcessId,CommandLine | ForEach-Object { '{0} {1}' -f $_.ProcessId, $_.CommandLine }",
        )
      : execFileSync('ps', ['-eo', 'pid=,command='], {
          encoding: 'utf8',
          timeout: 10000,
        })
  return table
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.includes(marker))
}

/**
 * Whether `pid` is a live process. On POSIX a zombie (exited, not reaped yet)
 * is not; Windows has no zombies to tell apart, and libuv answers signal 0 with
 * ESRCH once a process has exited even while handles to it remain open.
 */
export function isAlive(pid: number): boolean {
  if (process.platform !== 'win32') return processInfo(pid).alive
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    // Another user's process: it is there.
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

/**
 * A process's parent, group and whether it is running (a zombie is not).
 * Windows has no process groups: there `group` is 0, which reapAfter ignores.
 */
export function processInfo(pid: number) {
  if (process.platform === 'win32') {
    if (!isAlive(pid)) return { parent: 0, group: 0, alive: false }
    const parent = powershell(
      `$ErrorActionPreference = 'Stop'; (Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}').ParentProcessId`,
    ).trim()
    // Ended between the two looks.
    if (!parent) return { parent: 0, group: 0, alive: false }
    return { parent: Number(parent), group: 0, alive: true }
  }
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
  const deadline = Date.now() + requestTimeout(7000)
  while (isAlive(pid) && Date.now() < deadline) await delay(25)
  assert.equal(isAlive(pid), false, `owned peer ${pid} survived cleanup`)
}
export function reapAfter(
  t: import('node:test').TestContext,
  pid: number,
  group: number,
) {
  // When it started, read while the test runs, without holding it up (a
  // process-table read on Windows can take longer than a test's timeouts).
  const started = process.platform === 'win32' ? startedAt(pid) : undefined
  // Runs AFTER the assertions; also cleans detached groups when a mutant fails.
  t.after(async () => {
    // Windows has no process groups: end the tree under the process instead,
    // if it is still that process. By now it has usually exited and its PID
    // may be another's: in a soak, a server of a gateway beside this test,
    // which `taskkill /T` ended mid-request (hour 2 of 4.2.1-rc.3's soak).
    if (process.platform === 'win32') {
      const then = await started
      if (then === undefined || (await startedAt(pid)) !== then) return
      try {
        execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
        })
      } catch {
        // Gone already.
      }
      return
    }
    for (const target of [-group, pid]) {
      try {
        process.kill(target, 'SIGKILL')
      } catch (error) {
        if (!alreadyGone(error)) throw error
      }
    }
  })
}

/**
 * When Windows process `pid` started, which tells it from a later process
 * that took its PID; undefined once there is no such process.
 */
export function startedAt(pid: number): Promise<string | undefined> {
  return new Promise((resolve) =>
    execFile(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance -ClassName Win32_Process -Filter 'ProcessId=${pid}').CreationDate.Ticks`,
      ],
      { encoding: 'utf8', timeout: 30000, windowsHide: true },
      (error, stdout) =>
        resolve(error ? undefined : stdout.trim() || undefined),
    ),
  )
}

/**
 * Whether a signal failed because there was nothing left to signal, which is
 * what a safety-net kill after a test's assertions expects.
 *
 * ESRCH says so. On macOS so does EPERM: a group whose processes have all
 * exited but are not reaped yet refuses the signal. They are another
 * process's children here, so this test cannot reap them. Hour 27 of the
 * 4.2.0-rc.1 soak failed a test whose assertions had passed on exactly this.
 */
export const alreadyGone = (error: unknown) =>
  ['ESRCH', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')

/**
 * Resident memory and open descriptors of each of `pids`, for the resource
 * soaks. Windows has neither ps nor lsof: there the working set, and the open
 * handle count, which also counts the process's threads, events and other
 * kernel objects, so it moves more than descriptors do; `descriptorMargin`
 * is the growth each platform's gates allow. One query covers every PID.
 */
export function processUsage(
  pids: number[],
): { rssKiB: number; descriptors: number }[] {
  if (process.platform === 'win32') {
    const rows = new Map(
      powershell(
        `$ErrorActionPreference = 'Stop'; Get-Process -Id ${pids.join(',')} | ForEach-Object { '{0} {1} {2}' -f $_.Id, $_.WorkingSet64, $_.HandleCount }`,
      )
        .trim()
        .split(/\r?\n/)
        .map((line) => line.trim().split(/\s+/).map(Number))
        .map(([pid, bytes, handles]) => [
          pid,
          { rssKiB: Math.round(bytes / 1024), descriptors: handles },
        ]),
    )
    return pids.map((pid) => {
      const row = rows.get(pid)
      assert.ok(row, `process ${pid} is not running`)
      return row
    })
  }
  return pids.map((pid) => ({
    rssKiB: Number(
      execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
        encoding: 'utf8',
      }).trim(),
    ),
    descriptors:
      process.platform === 'linux'
        ? readdirSync(`/proc/${pid}/fd`).length
        : execFileSync('lsof', ['-p', String(pid), '-Ff'], {
            encoding: 'utf8',
          })
            .split('\n')
            .filter((line) => /^f\d/.test(line)).length,
  }))
}

/**
 * How far descriptors may grow over a soak before it is called a leak. On
 * Windows every gateway, in every mode, settled at 234 handles from a fresh
 * 225 and stayed there for 20 minutes of load (probe run 38884134053): a step
 * on first use, from the threads Node starts when it needs them, not growth.
 * A leak of one handle per connection passes 24 within minutes of a soak.
 */
export const descriptorMargin = process.platform === 'win32' ? 24 : 8

/**
 * Processes one stdio server is: on Windows cmd.exe and the server under it
 * (`--stdio` runs through the shell, and cmd.exe has no `exec`), elsewhere the
 * server alone once its shell has exec'd it. Budgets that count descendants
 * are budgets of servers times this.
 */
export const processesPerServer = process.platform === 'win32' ? 2 : 1
