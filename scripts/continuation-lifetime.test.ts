// Finite checks against an installed artifact, using real clocks and processes.
// Runs once per soak phase; no timer replacement or production configuration override.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { launchGateway, unusedPort } from '../tests/helpers/gateway-process.js'

assert.ok(process.env.SUPERGATEWAY_TEST_ENTRY, 'Select an installed artifact')
const version = '2026-07-28'
const roots = { roots: [{ uri: 'file:///scratch', name: 'scratch' }] }
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function until(
  check: () => boolean,
  timeout: number,
  description: string,
) {
  const deadline = Date.now() + timeout
  while (!check()) {
    assert.ok(Date.now() < deadline, description)
    await delay(100)
  }
}
async function setup(t: TestContext, stateful: boolean) {
  const directory = mkdtempSync(join(tmpdir(), 'rc1-lifetime-'))
  const tracePath = join(directory, 'trace.jsonl')
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      'node tests/helpers/signed-continuation-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      ...(stateful ? ['--stateful'] : []),
    ],
    { CONTINUATION_TRACE: tracePath },
  )
  await gateway.ready()
  let id = 0
  const pids = () =>
    readFileSync(tracePath, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.event === 'start')
      .map((row) => row.pid as number)
  const call = async (handle?: string, rounds = 1) => {
    const requestId = ++id
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        'mcp-method': 'tools/call',
        'mcp-name': 'roots',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'tools/call',
        params: {
          name: 'roots',
          arguments: { rounds },
          _meta: {
            'io.modelcontextprotocol/protocolVersion': version,
            'io.modelcontextprotocol/clientInfo': {
              name: 'rc1-lifetime',
              version: '1',
            },
            'io.modelcontextprotocol/clientCapabilities': { roots: {} },
          },
          ...(handle
            ? { requestState: handle, inputResponses: { locations: roots } }
            : {}),
        },
      }),
    })
    const text = await response.text()
    const messages = response.headers
      .get('content-type')
      ?.includes('text/event-stream')
      ? text
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5)))
      : [JSON.parse(text)]
    const result = messages.find((message) => message.id === requestId)
    assert.ok(result, text)
    return result
  }
  const mint = async (handle?: string, rounds = 1) => {
    const message = await call(handle, rounds)
    assert.equal(message.error, undefined)
    assert.equal(message.result.resultType, 'input_required')
    assert.match(message.result.requestState, /^sgw:/)
    return message.result.requestState as string
  }
  const close = async () => {
    const owned = pids()
    gateway.child.stdin.end()
    await until(
      () =>
        gateway.child.exitCode !== null || gateway.child.signalCode !== null,
      15000,
      'gateway did not stop on stdin EOF',
    )
    assert.equal((await gateway.exited).code, 0)
    await until(
      () => owned.every((pid) => !alive(pid)),
      10000,
      'owned children survived gateway shutdown',
    )
  }
  return { call, mint, pids, close }
}

test(
  'installed CLI: capacity eviction and crashed continuation cannot reach another process',
  { timeout: 180000 },
  async (t) => {
    for (const stateful of [false, true]) {
      const peer = await setup(t, stateful)
      const victim = await peer.mint()
      const [victimPid] = peer.pids()
      let handle = await peer.mint(undefined, 100)
      // 64 saved states share one other process, avoiding 64 fixture processes.
      for (let n = 1; n < 64; n++) {
        assert.ok(
          alive(victimPid),
          `oldest child evicted before state ${n + 2}`,
        )
        handle = await peer.mint(handle, 100)
      }
      await until(
        () => !alive(victimPid),
        10000,
        '65th state did not evict the oldest child',
      )
      assert.equal((await peer.call(victim)).error?.code, -32602)
      const pids = peer.pids()
      assert.equal(
        pids.length,
        2,
        'continuation rounds must reuse one owning process',
      )
      const healthy = await peer.call(handle, 1)
      assert.equal(healthy.error, undefined)
      assert.equal(
        JSON.parse(healthy.result.content[0].text).state.pid,
        pids[1],
      )
      process.kill(pids[1], 'SIGKILL')
      await until(() => !alive(pids[1]), 10000, 'fixture crash did not finish')
      await delay(250)
      assert.equal((await peer.call(handle)).error?.code, -32602)
      assert.equal(
        peer.pids().length,
        2,
        'invalid state must not launch a replacement',
      )
      const next = await peer.mint()
      const resumed = await peer.call(next)
      assert.equal(resumed.error, undefined)
      assert.equal(
        JSON.parse(resumed.result.content[0].text).state.pid,
        peer.pids()[2],
      )
      await peer.close()
      t.diagnostic(`stateful=${stateful}: capacity and crash checks passed`)
    }
  },
)

test(
  'installed CLI: abandoned and completed continuations expire after five idle minutes',
  { timeout: 380000 },
  async (t) => {
    const peers = await Promise.all([setup(t, false), setup(t, true)])
    const records = await Promise.all(
      peers.map(async (peer) => {
        const started = Date.now()
        const abandoned = await peer.mint()
        const completed = await peer.mint()
        const first = await peer.call(completed)
        assert.equal(first.error, undefined)
        const delayed = await peer.mint()
        await delay(2000)
        assert.ok(
          peer.pids().every(alive),
          'response completion must preserve continuations',
        )
        assert.deepEqual((await peer.call(completed)).result, first.result)
        const late = await peer.call(delayed)
        assert.equal(late.error, undefined)
        assert.equal(
          JSON.parse(late.result.content[0].text).state.pid,
          peer.pids()[2],
        )
        return {
          peer,
          started,
          handles: [abandoned, completed, delayed],
          pids: peer.pids(),
        }
      }),
    )
    await delay(
      Math.max(
        0,
        Math.min(...records.map((record) => record.started)) +
          295000 -
          Date.now(),
      ),
    )
    for (const record of records)
      assert.ok(
        record.pids.every(alive),
        'retention ended before five idle minutes',
      )
    await until(
      () => records.every((record) => record.pids.every((pid) => !alive(pid))),
      60000,
      'idle continuations did not expire and release children',
    )
    for (const { peer, handles, pids } of records) {
      for (const handle of handles)
        assert.equal((await peer.call(handle)).error?.code, -32602)
      assert.equal(
        peer.pids().length,
        pids.length,
        'expired handles must not start new processes',
      )
      await peer.close()
    }
    t.diagnostic(
      'Both HTTP configurations released abandoned and completed continuations without forced GC or shortened expiry',
    )
  },
)
