import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

/**
 * Regression test for issue #141: in --stateful streamableHttp mode the stdio
 * child (and its whole process tree) must be reaped when its session closes.
 *
 * The bug composes two halves:
 *   1. Close-path cleanup gated on transport.sessionId (undefined at close).
 *   2. spawn(cmd, { shell: true }) => a `sh -c` wrapper; a plain child.kill()
 *      signals only ONE process. Any descendants (the wrapper's real MCP child,
 *      or grandchildren that MCP server spawns) are not signalled and orphan.
 *      On dash/ash the wrapper itself is the survivor; but the general defect
 *      is that a single-PID kill cannot reap a process tree.
 *
 * We reproduce this shell-independently: the stdio MCP server spawns a
 * descendant "worker" (see tests/helpers/mock-mcp-server.js, gated on
 * LEAK_PID_FILE) that stays in the same process group and records its own PID.
 * A single-process child.kill() (pre-fix) never reaches that grandchild, so it
 * survives the session's close. The post-fix gateway spawns detached and
 * signals the whole process group (negative PID), reaping the entire tree
 * regardless of shell signal-forwarding or exec-optimization behaviour.
 *
 * Liveness is checked directly via process.kill(pid, 0) — no pgrep/procps
 * dependency.
 */

const PORT = 11007
const MCP_URL = `http://localhost:${PORT}/mcp`
const PID_FILE = join(tmpdir(), `supergateway-141-${randomUUID()}.pid`)

const STDIO_CMD = `node tests/helpers/mock-mcp-server.js stdio`

let gatewayProc: ChildProcess

const isAlive = (pid: number): boolean => {
  // A zombie (killed but not yet reaped) still answers kill(pid, 0). That can
  // happen when the reaper is absent — e.g. the test runs as PID 1 in a bare
  // container. Treat a zombie as gone by checking /proc state on Linux; on
  // platforms without /proc (macOS), kill(pid, 0) is authoritative.
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const state = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]
    return state !== 'Z'
  } catch {
    if (existsSync('/proc/self')) return false // Linux: no /proc/<pid> => gone
  }
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.before(() => {
  // Spawn the BUILT entrypoint directly (node dist/index.js), the way the
  // supergateway image runs in production — NOT via `npm run start`. npm runs
  // lifecycle scripts in their own process group and reaps that group on exit,
  // which would mask the very orphan this test asserts against. Requires a
  // prior `npm run build`, consistent with the rest of the suite (which runs
  // the built code through `npm run start`) and with AGENTS.md.
  gatewayProc = spawn(
    process.execPath,
    [
      'dist/index.js',
      '--stdio',
      STDIO_CMD,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(PORT),
      '--streamableHttpPath',
      '/mcp',
    ],
    {
      stdio: 'ignore',
      shell: false,
      env: { ...process.env, LEAK_PID_FILE: PID_FILE },
    },
  )
  gatewayProc.unref()
})

test.after(async () => {
  // Best-effort: reap the recorded child if a (pre-fix) failure left it alive,
  // so a failing run does not leave orphans behind.
  try {
    if (existsSync(PID_FILE)) {
      const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
      if (Number.isInteger(pid) && isAlive(pid)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }
  } finally {
    rmSync(PID_FILE, { force: true })
  }

  gatewayProc.kill('SIGINT')
  await new Promise((resolve) => gatewayProc.once('exit', resolve))
})

test('stateful session close reaps the spawned stdio child (issue #141)', async () => {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
  const client = new Client({ name: 'lifecycle-test', version: '1.0.0' })
  await new Promise((r) => setTimeout(r, 2000))
  await client.connect(transport)
  assert.ok(transport.sessionId, 'sessionId should be set after connect')

  // The MCP server spawns a descendant worker that writes its PID; wait for it.
  let childPid = 0
  for (let i = 0; i < 50 && childPid === 0; i++) {
    if (existsSync(PID_FILE)) {
      const raw = readFileSync(PID_FILE, 'utf8').trim()
      if (raw) childPid = Number(raw)
    }
    if (childPid === 0) await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(
    Number.isInteger(childPid) && childPid > 0,
    'spawned MCP child should have recorded its PID',
  )
  assert.ok(
    isAlive(childPid),
    `spawned child (pid ${childPid}) should be alive while the session is open`,
  )

  // Close the session — this drives the gateway's transport-close cleanup path.
  await transport.terminateSession()
  assert.strictEqual(transport.sessionId, undefined)
  await client.close()
  transport.close()

  // Post-fix: the whole process group is signalled, so the descendant worker
  // exits. Pre-fix: a single-PID child.kill() never reaches it and it orphans.
  let gone = false
  for (let i = 0; i < 50 && !gone; i++) {
    if (!isAlive(childPid)) {
      gone = true
      break
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  assert.ok(
    gone,
    `spawned child (pid ${childPid}) must be reaped after the session closes; ` +
      `still alive => orphaned stdio process (issue #141 leak)`,
  )
})
