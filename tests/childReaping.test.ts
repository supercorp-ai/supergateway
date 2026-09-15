import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import type { TestContext } from 'node:test'
import { knownBugTest } from './helpers/known-bug.js'
import { launchGateway, rpc, unusedPort } from './helpers/gateway-process.js'

/**
 * Which configurations actually reap the child a request spawned?
 *
 * A stateless child belongs to one request; a stateful child belongs to a
 * session spanning multiple HTTP requests. Response completion is therefore
 * not a universal cleanup trigger. The expected lifetime depends on the mode:
 *
 *   explicit DELETE        stateless: no sessions      stateful: yes
 *   idle timer             stateless: none             stateful: only with --sessionTimeout
 *   res.on('finish'/'close')  stateless: absent        stateful: feeds the session counter,
 *                                                      which is null without --sessionTimeout
 *
 * #108 is a completed-request leak. The former #141 TODO below incorrectly
 * expected initialized stateful sessions with no timeout or DELETE to vanish.
 * It did not reproduce an actual transport-close leak. Preserve those sessions
 * and test the reported close-path issue separately before claiming it fixed.
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
 * Correction to the former #141 reproducer: no session termination happened.
 * Three children after three initializations are expected when idle expiry is
 * disabled. Assert that the original children remain usable, not only alive.
 * statefulSessionContinuityE2e additionally checks peer PID and retained state.
 */
test(
  'stateful HTTP preserves sessions between responses when idle expiry is disabled',
  { timeout: 30000 },
  async (t) => {
    const { marker, url, sessions } = await openSessions(
      t,
      ['--outputTransport', 'streamableHttp', '--stateful'],
      3,
    )
    assert.equal(sessions.length, 3)
    const original = liveChildren(marker)
    assert.ok(original.length >= 3)
    await settle()
    assert.deepEqual(
      liveChildren(marker),
      original,
      'response completion must not destroy a live session’s child',
    )
    for (const session of sessions) {
      const listed = await rpc(
        url,
        { jsonrpc: '2.0', id: 10, method: 'tools/list' },
        session,
      )
      assert.equal(listed.response.status, 200)
      assert.equal(listed.messages.length, 1)
      assert.equal(listed.messages[0].id, 10)
      assert.ok(Array.isArray(listed.messages[0].result.tools))
    }
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
