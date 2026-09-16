import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { auditClient } from './helpers/audit-client.js'

function alive(pid: number) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim()
    return state.length > 0 && !state.startsWith('Z')
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false
    throw error // Missing process inspection must never count as a clean reap.
  }
}

for (const mode of ['sse', 'stateful', 'stateless', 'ws'] as const) {
  for (const wrapped of [false, true]) {
    test(
      `${mode} parent-only SIGTERM stops ${wrapped ? 'a wrapped background MCP peer' : 'a cooperative direct peer'}`,
      { timeout: 15000 },
      async (t) => {
        const b = await auditClient(
          t,
          mode,
          wrapped
            ? 'exec node tests/helpers/fault-wrapper.mjs'
            : mode === 'stateless'
              ? 'exec node tests/helpers/fault-peer.mjs'
              : 'exec node tests/helpers/lifecycle-identity-peer.mjs',
        )
        assert.ok(Number.isInteger(b.pid) && b.pid > 0)
        assert.equal(
          alive(b.pid),
          true,
          'the actual peer is alive before shutdown',
        )
        const group = Number(
          execFileSync('ps', ['-o', 'pgid=', '-p', String(b.pid)], {
            encoding: 'utf8',
          }).trim(),
        )
        t.after(() => {
          // Separate safety net for the newly detached child group, after the assertion.
          try {
            process.kill(-group, 'SIGKILL')
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
          }
        })
        b.gateway.child.kill('SIGTERM') // Never signal the whole group for the assertion.
        const exit = await b.gateway.exited
        assert.equal(exit.code, 0)
        const deadline = Date.now() + 1500
        while (alive(b.pid) && Date.now() < deadline) await delay(20)
        assert.equal(
          alive(b.pid),
          false,
          `peer ${b.pid} survived gateway SIGTERM; test teardown has not run yet`,
        )
      },
    )
  }
}
