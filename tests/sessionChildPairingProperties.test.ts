import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { setTimeout as delay } from 'node:timers/promises'
import {
  initialize,
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'
import { descendantsOf } from './helpers/process-tree.js'

/**
 * The stateful gateway spawns one child per session and must reap it when the
 * session ends. Both halves of that have failed in the field — #108 is a child
 * per POST that is never reaped until the container is OOM-killed, #141 and
 * #160 are orphans — and the binding behind it, `transports`, is the most
 * captured mutable state in the codebase (6 closures, alongside
 * `sessionCounter` at 7).
 *
 * The existing tests open one session and close it. That shape cannot see a
 * leak, because one of anything looks the same whether or not it accumulates:
 * the bug needs a *sequence*, which is what this generates. It is the same
 * lesson as the v3.3 rollback, where the concurrency tests ran 1000 requests
 * and missed a bug that needed two long-lived clients — demanding along the
 * wrong axis.
 *
 * The invariant is deliberately a band rather than an exact count. A gateway
 * spawns its child through `/bin/sh`, and whether that shell execs or forks
 * differs by platform, so one session is one or two processes. The band still
 * pins both directions: growth beyond the open sessions is a leak, and falling
 * below them means a live session lost its child.
 */
const operation = fc.constantFrom(
  'open' as const,
  'use' as const,
  'close' as const,
)

test(
  'live children track open sessions across any sequence of opens and closes',
  { timeout: 120000 },
  async (t) => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operation, { minLength: 1, maxLength: 10 }),
        async (operations) => {
          const port = await unusedPort()
          const gateway = launchGateway(t, [
            '--stdio',
            peerCommand,
            '--outputTransport',
            'streamableHttp',
            '--stateful',
            // Long enough that nothing expires mid-sequence: idle cleanup is a
            // different property, and letting it fire here would make this test
            // measure the clock instead of the bookkeeping.
            '--sessionTimeout',
            '60000',
            '--port',
            String(port),
          ])
          try {
            await gateway.ready()
            const url = `http://127.0.0.1:${port}/mcp`
            const headers = {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            }
            const open: string[] = []

            const settled = async (expected: number) => {
              const deadline = Date.now() + 4000
              for (;;) {
                const live = descendantsOf(gateway.child.pid!).length
                const ok =
                  expected === 0
                    ? live === 0
                    : live >= expected && live <= expected * 2
                if (ok || Date.now() > deadline) return live
                await delay(50)
              }
            }

            for (const operation of operations) {
              if (operation === 'open') {
                const response = await fetch(url, {
                  method: 'POST',
                  headers,
                  body: JSON.stringify(initialize()),
                })
                await response.text()
                const session = response.headers.get('mcp-session-id')
                assert.ok(session, 'initialize must hand back a session id')
                open.push(session)
              } else if (open.length === 0) {
                continue
              } else if (operation === 'use') {
                const session = open[0]
                const response = await fetch(url, {
                  method: 'POST',
                  headers: { ...headers, 'mcp-session-id': session },
                  body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 7,
                    method: 'tools/list',
                  }),
                })
                await response.text()
                assert.equal(
                  response.status,
                  200,
                  'a session that was never closed still answers',
                )
              } else {
                const session = open.shift()!
                const response = await fetch(url, {
                  method: 'DELETE',
                  headers: { 'mcp-session-id': session },
                })
                await response.text()
                assert.equal(
                  response.status,
                  200,
                  'closing a session the gateway handed out succeeds',
                )
              }

              const live = await settled(open.length)
              assert.ok(
                open.length === 0 ? live === 0 : live >= open.length,
                `after ${operation}: ${open.length} open session(s) but only ` +
                  `${live} live child process(es) — a session lost its child`,
              )
              assert.ok(
                live <= open.length * 2,
                `after ${operation}: ${live} live child process(es) for ` +
                  `${open.length} open session(s) — children are accumulating`,
              )
            }
          } finally {
            await gateway.dispose()
          }
        },
      ),
      { numRuns: 8 },
    )
  },
)
