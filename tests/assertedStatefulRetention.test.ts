import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// A stateful session that has ended must not stay reachable. Every session
// under the default --sessionTimeout carries a liveness probe whose callbacks
// hold its transport and server; if the gateway kept any reference to a closed
// session's probe, each session ever opened would stay in memory until the
// gateway exits. The gateway runs with a preload that counts the probes it
// closes and how many the garbage collector reclaims.

const sessions = 4

test(
  'a stateful gateway releases the sessions it has closed',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(
      t,
      [
        '--stdio',
        peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--stateful',
        '--port',
        String(port),
      ],
      undefined,
      [
        '--expose-gc',
        '--import',
        fileURLToPath(
          new URL('./helpers/probe-retention.mjs', import.meta.url),
        ),
      ],
    )
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    for (let i = 0; i < sessions; i++) {
      const session = (await rpc(url, initialize())).response.headers.get(
        'mcp-session-id',
      )!
      assert.ok(session)
      const ended = await fetch(url, {
        method: 'DELETE',
        headers: { 'mcp-session-id': session },
        signal: AbortSignal.timeout(requestTimeout(5000)),
      })
      assert.equal(ended.status, 200)
      await ended.text()
    }
    const counts = () => {
      const lines = gateway.errors().match(/\[probe-retention\] [^\n]*/g) ?? []
      const last = lines.at(-1) ?? ''
      return {
        closed: Number(/closed=(\d+)/.exec(last)?.[1] ?? 0),
        collected: Number(/collected=(\d+)/.exec(last)?.[1] ?? 0),
      }
    }
    const deadline = Date.now() + requestTimeout(15000)
    while (counts().collected < sessions) {
      assert.ok(
        Date.now() < deadline,
        `closed sessions were not reclaimed: ${JSON.stringify(counts())}\n${gateway.errors()}`,
      )
      await delay(50)
    }
    // map: closed-sessions-released
    assert.deepEqual(counts(), { closed: sessions, collected: sessions })
  },
)
