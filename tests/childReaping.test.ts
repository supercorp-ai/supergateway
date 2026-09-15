import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import type { TestContext } from 'node:test'
import { knownBugTest } from './helpers/known-bug.js'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * Which configurations actually reap the child a request spawned?
 *
 * Neither HTTP gateway ties child lifetime to the HTTP response ending: both
 * kill their child from `transport.onclose` and `transport.onerror` only, so the
 * child dies exactly when something *else* closes the transport. There are three
 * such somethings, and a configuration with none of them leaks:
 *
 *   explicit DELETE        stateless: no sessions      stateful: yes
 *   idle timer             stateless: none             stateful: only with --sessionTimeout
 *   res.on('finish'/'close')  stateless: absent        stateful: feeds the session counter,
 *                                                      which is null without --sessionTimeout
 *
 * So #108 (stateless children never cleaned up) and #141 (children only reaped
 * by --sessionTimeout, not by the close path) are the same defect in two
 * gateways, and the two passing cases below are the configurations that happen
 * to have a reaper.
 *
 * Children are counted by a marker passed to the peer's own argv, and the
 * gateway is excluded from the count because the peer command — marker and all
 * — appears in the gateway's argv too, which is how it was told what to spawn.
 */
const peerWithMarker = (marker: string) =>
  `node tests/clients/battery-peer.mjs ${marker}`

function liveChildren(marker: string) {
  const out = execSync(
    `ps -eo pid,command | grep -F ${JSON.stringify(marker)} | grep -v grep || true`,
    { encoding: 'utf8' },
  )
  return out
    .split('\n')
    .filter((line) => line.trim() && !line.includes('dist/index.js'))
    .map((line) => line.trim())
}

const headers = (session?: string) => ({
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  ...(session ? { 'mcp-session-id': session } : {}),
})

const initialize = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'reaping', version: '1.0.0' },
  },
})

async function openSessions(t: TestContext, extra: string[], count: number) {
  const marker = `reaping-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerWithMarker(marker),
    '--port',
    String(port),
    ...extra,
  ])
  await gateway.ready()
  const url = `http://127.0.0.1:${port}/mcp`
  const sessions: string[] = []
  for (let i = 1; i <= count; i++) {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(initialize(i)),
      signal: AbortSignal.timeout(8000),
    })
    await response.text()
    const id = response.headers.get('mcp-session-id')
    if (id) sessions.push(id)
  }
  return { marker, url, sessions, gateway }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 3000))

test(
  'stateful HTTP reaps a session’s child on explicit DELETE',
  { timeout: 30000 },
  async (t) => {
    const { marker, url, sessions } = await openSessions(
      t,
      ['--outputTransport', 'streamableHttp', '--stateful'],
      3,
    )
    for (const session of sessions) {
      const ended = await fetch(url, {
        method: 'DELETE',
        headers: headers(session),
        signal: AbortSignal.timeout(5000),
      })
      await ended.text()
    }
    await settle()
    assert.deepEqual(
      liveChildren(marker),
      [],
      'no child may outlive the session that spawned it',
    )
  },
)

test(
  'stateful HTTP reaps an idle session’s child when --sessionTimeout is set',
  { timeout: 30000 },
  async (t) => {
    const { marker } = await openSessions(
      t,
      [
        '--outputTransport',
        'streamableHttp',
        '--stateful',
        '--sessionTimeout',
        '800',
      ],
      3,
    )
    await settle()
    assert.deepEqual(
      liveChildren(marker),
      [],
      'the idle timer must reap every child it was given',
    )
  },
)

/**
 * #141. Without `--sessionTimeout` the session counter is never constructed
 * (`sessionTimeout ? new SessionAccessCounter(...) : null`), so the close path
 * has nothing to drive and a client that simply goes away leaves its child
 * running. Measured: three requests, three children still alive three seconds
 * later, and they exit only when the gateway does.
 */
knownBugTest(
  '#141',
  'stateful HTTP reaps a child when the client leaves without DELETE',
  { timeout: 30000 },
  async (t) => {
    const { marker } = await openSessions(
      t,
      ['--outputTransport', 'streamableHttp', '--stateful'],
      3,
    )
    await settle()
    assert.deepEqual(
      liveChildren(marker),
      [],
      'a session nobody closed still owns a process',
    )
  },
)

/**
 * #108. The stateless gateway spawns a child per POST and has no
 * `res.on('close')` hook at all, so nothing ever closes the transport and
 * nothing ever kills the child. This is the worse of the two, because it is one
 * process per request with no ceiling.
 */
knownBugTest(
  '#108',
  'stateless HTTP reaps the child it spawned for a completed request',
  { timeout: 30000 },
  async (t) => {
    const { marker } = await openSessions(
      t,
      ['--outputTransport', 'streamableHttp'],
      3,
    )
    await settle()
    assert.deepEqual(
      liveChildren(marker),
      [],
      'one completed request must not leave a process behind',
    )
  },
)
