import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { auditClient } from './helpers/audit-client.js'
import { gatewayTimeout, nodeServer } from './helpers/gateway-process.js'
import { alreadyGone, isAlive } from './helpers/process-tree.js'

// Live, and not a zombie: the shared check, which works on Windows too.
const alive = isAlive

for (const mode of ['sse', 'stateful', 'stateless', 'ws'] as const) {
  for (const wrapped of [false, true]) {
    test(
      `${mode} parent-only SIGTERM stops ${wrapped ? 'a wrapped background MCP peer' : 'a cooperative direct peer'}`,
      { timeout: gatewayTimeout(15000) },
      async (t) => {
        const b = await auditClient(
          t,
          mode,
          wrapped
            ? nodeServer('tests/helpers/fault-wrapper.mjs')
            : mode === 'stateless'
              ? nodeServer('tests/helpers/fault-peer.mjs')
              : nodeServer('tests/helpers/lifecycle-identity-peer.mjs'),
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
            if (!alreadyGone(error)) throw error
          }
        })
        b.gateway.interrupt('SIGTERM') // Never signal the whole group for the assertion.
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
