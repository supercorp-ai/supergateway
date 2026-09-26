// Opt-in sustained scenarios against an installed candidate, never part of
// npm test. Runs alongside soak-release.test.ts, with its own resource gates.
// Only after user confirmation: SUPERGATEWAY_SOAK_CONFIRMED=1
// SOAK_SECONDS=600 SUPERGATEWAY_TEST_ENTRY=/.../dist/index.js
// node --import tsx --test scripts/soak-scenarios.test.ts
//
// What it repeats, for the whole run:
// - two bridges (SSE and Streamable HTTP) kept connected throughout, relaying
//   logs, progress and sampling, cancelling slow calls, carrying large replies,
//   and recovering when the gateway behind them restarts;
// - two WebSocket clients per round, one busy and one idle: the idle one must
//   receive nothing (one child per connection);
// - SSE and stateful HTTP clients doing the same work, and servers crashing
//   mid-call in every mode.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CreateMessageRequestSchema,
  LoggingMessageNotificationSchema,
  ProgressNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { unusedPort } from '../tests/helpers/gateway-process.js'
import { descendantsOf, processInfo } from '../tests/helpers/process-tree.js'

globalThis.WebSocket ??= WebSocket as unknown as typeof globalThis.WebSocket

assert.equal(
  process.env.SUPERGATEWAY_SOAK_CONFIRMED,
  '1',
  'Soak requires explicit user confirmation; do not start it as part of release preparation',
)
const seconds = Number(process.env.SOAK_SECONDS ?? 600)
assert.ok(Number.isFinite(seconds) && seconds >= 60)
const entry = process.env.SUPERGATEWAY_TEST_ENTRY
const report = process.env.SOAK_REPORT ?? '.release/soak-scenarios.jsonl'
mkdirSync(dirname(report), { recursive: true })
const emit = (row: object) =>
  appendFileSync(
    report,
    JSON.stringify({ time: new Date().toISOString(), ...row }) + '\n',
  )
const PEER = 'node tests/helpers/soak-peer.mjs'
const BIG = 4 * 1024 * 1024
const CALL = { timeout: 30000 }

// A gateway process on a fixed port, restartable, with a bounded log tail.
function gateway(t: TestContext, port: number, output: string[]) {
  let child: ReturnType<typeof spawn>
  let spawnedAt = 0
  let tail = ''
  // Error lines, kept apart: 4 MB replies are logged in full at the default
  // level and would push them out of the tail.
  let errors: string[] = []
  const start = async () => {
    spawnedAt = Date.now()
    tail = ''
    child = spawn(
      process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath,
      [entry!, '--stdio', PEER, '--port', String(port), ...output],
      { stdio: 'pipe', detached: true },
    )
    for (const stream of [child.stdout!, child.stderr!])
      stream.setEncoding('utf8').on('data', (chunk: string) => {
        tail = (tail + chunk).slice(-65536)
        for (const line of chunk.split('\n'))
          if (/error|failed|ECONN|EPIPE|stale|timed out/i.test(line))
            errors = [...errors, line.slice(0, 500)].slice(-50)
      })
    const deadline = Date.now() + 15000
    while (!/Listening on port/.test(tail)) {
      assert.ok(child.exitCode === null && Date.now() < deadline, tail)
      await delay(25)
    }
    emit({ phase: 'gateway-start', pid: child.pid, output })
  }
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const owned = descendantsOf(child.pid!, { since: spawnedAt })
    const exited = once(child, 'exit')
    child.kill('SIGTERM')
    await Promise.race([exited, delay(7000)])
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    for (const pid of owned)
      assert.equal(processInfo(pid).alive, false, `descendant ${pid} survived`)
    emit({
      phase: 'gateway-stopped',
      pid: child.pid,
      errors,
      diagnostics: tail.slice(-8192),
    })
  }
  t.after(stop)
  return {
    start,
    stop,
    restart: async () => {
      await stop()
      await start()
    },
    pid: () => child.pid!,
    spawnedAt: () => spawnedAt,
  }
}

function usage(pid: number) {
  const rssKiB = Number(
    execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim(),
  )
  const descriptors =
    process.platform === 'linux'
      ? readdirSync(`/proc/${pid}/fd`).length
      : execFileSync('lsof', ['-p', String(pid), '-Ff'], { encoding: 'utf8' })
          .split('\n')
          .filter((line) => /^f\d/.test(line)).length
  return { rssKiB, descriptors }
}

// A client that answers sampling and records log messages.
function client(name: string) {
  const logs: string[] = []
  const progress: number[] = []
  const c = new Client(
    { name, version: '1.0.0' },
    { capabilities: { sampling: {} } },
  )
  c.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
    logs.push(String(n.params.data))
  })
  // Our own handler, not the SDK's per-call onprogress: the SDK deletes that
  // callback when the result arrives, and progress read in the same chunk as
  // the result is then dropped (GW-027, a client bug). Under soak load the
  // gateway can deliver them together; this counts what actually arrived.
  c.setNotificationHandler(ProgressNotificationSchema, (n) => {
    progress.push(n.params.progress)
  })
  c.setRequestHandler(CreateMessageRequestSchema, async () => ({
    model: 'soak',
    role: 'assistant',
    content: { type: 'text', text: 'pong' },
  }))
  return { client: c, logs, progress }
}

const textOf = (result: unknown) =>
  (result as { content: Array<{ text: string }> }).content[0].text

/** Run one step of a scenario; a failure says which step it was. */
async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    throw new Error(`${name}: ${(error as Error)?.message ?? error}`, {
      cause: error,
    })
  }
}

/** The work one connection does in a round. Every answer is checked. */
async function exercise(
  label: string,
  { client: c, logs, progress }: ReturnType<typeof client>,
  round: number,
  { sampling = true, big = round % 5 === 0 } = {},
) {
  const tag = `${label}-${round}`
  logs.length = 0
  progress.length = 0
  assert.equal(
    textOf(
      await step('chatty', () =>
        c.callTool(
          { name: 'chatty', arguments: { tag }, _meta: { progressToken: tag } },
          undefined,
          CALL,
        ),
      ),
    ),
    `chatty:${tag}`,
  )
  // Notifications can trail the reply by a moment on some transports.
  const until = Date.now() + 5000
  while ((logs.length < 3 || progress.length < 3) && Date.now() < until)
    await delay(20)
  assert.deepEqual(logs, [`${tag}:1`, `${tag}:2`, `${tag}:3`], `${label} logs`)
  assert.deepEqual(progress, [1, 2, 3], `${label} progress`)
  if (sampling)
    assert.equal(
      textOf(
        await step('sample', () =>
          c.callTool({ name: 'sample', arguments: { tag } }, undefined, CALL),
        ),
      ),
      'sampled:pong',
      `${label} sampling`,
    )
  // A cancelled call must fail for the caller and leave the connection usable.
  const abort = new AbortController()
  const slow = c.callTool(
    { name: 'slow', arguments: { ms: 20000 } },
    undefined,
    {
      ...CALL,
      signal: abort.signal,
    },
  )
  await delay(100)
  abort.abort('soak cancel')
  await assert.rejects(slow, undefined, `${label} cancel`)
  if (big) {
    const result = await step('big', () =>
      c.callTool({ name: 'big', arguments: { bytes: BIG } }, undefined, CALL),
    )
    assert.equal(textOf(result).length, BIG, `${label} large reply`)
  }
}

const connect = async (transport: Transport, name: string) => {
  const connected = client(name)
  await step(`connect ${name}`, () => connected.client.connect(transport, CALL))
  return connected
}

/** Retry a bridge call until the gateway behind it is back. */
async function recovered(label: string, attempt: () => Promise<void>) {
  const deadline = Date.now() + 30000
  for (;;) {
    try {
      return await attempt()
    } catch (error) {
      if (Date.now() > deadline)
        throw new Error(`${label} did not recover after a restart`, {
          cause: error,
        })
      await delay(500)
    }
  }
}

test(
  'soak scenarios: long-lived bridges, WebSocket isolation, cancellation, large replies and crashes',
  { timeout: (seconds + 300) * 1000 },
  async (t) => {
    assert.ok(entry, 'Select the installed artifact explicitly')
    const ports = {
      sse: await unusedPort(),
      stateful: await unusedPort(),
      stateless: await unusedPort(),
      ws: await unusedPort(),
    }
    const gateways = {
      sse: gateway(t, ports.sse, ['--outputTransport', 'sse']),
      stateful: gateway(t, ports.stateful, [
        '--outputTransport',
        'streamableHttp',
        '--stateful',
      ]),
      stateless: gateway(t, ports.stateless, [
        '--outputTransport',
        'streamableHttp',
      ]),
      ws: gateway(t, ports.ws, ['--outputTransport', 'ws']),
    }
    for (const g of Object.values(gateways)) await g.start()
    const url = {
      sse: `http://127.0.0.1:${ports.sse}/sse`,
      stateful: `http://127.0.0.1:${ports.stateful}/mcp`,
      stateless: `http://127.0.0.1:${ports.stateless}/mcp`,
      ws: `ws://127.0.0.1:${ports.ws}/message`,
    }

    // The two bridges stay connected for the whole run.
    const bridgeTransports = {
      sse: new StdioClientTransport({
        command: process.execPath,
        args: [entry!, '--sse', url.sse, '--logLevel', 'none'],
      }),
      http: new StdioClientTransport({
        command: process.execPath,
        args: [entry!, '--streamableHttp', url.stateful, '--logLevel', 'none'],
      }),
    }
    const bridges = {
      sse: await connect(bridgeTransports.sse, 'bridge-sse'),
      http: await connect(bridgeTransports.http, 'bridge-http'),
    }
    t.after(async () => {
      for (const b of Object.values(bridges))
        await b.client.close().catch(() => {})
    })

    const sample = (phase: string, round: number, withBridges = true) => {
      const rows = [
        ...Object.entries(gateways).map(([mode, g]) => ({
          mode,
          pid: g.pid(),
          ...usage(g.pid()),
          children: descendantsOf(g.pid(), { since: g.spawnedAt() }).length,
        })),
        ...Object.entries(withBridges ? bridgeTransports : {}).map(
          ([mode, transport]) => ({
            mode: `bridge-${mode}`,
            pid: transport.pid!,
            ...usage(transport.pid!),
            children: 0,
          }),
        ),
      ]
      emit({ phase, round, rows })
      return rows
    }

    let round = 0,
      restarts = 0,
      crashes = 0
    const baseline = sample('baseline', 0)
    const warmSamples: ReturnType<typeof sample>[] = []
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      const work: Array<Promise<void>> = []
      // Every failure names its scenario and round.
      const add = (label: string, job: Promise<void>) =>
        work.push(
          job.catch((error) => {
            throw new Error(
              `${label}, round ${round}: ${error?.message ?? error}`,
              {
                cause: error,
              },
            )
          }),
        )

      // Long-lived bridges, through the gateways behind them.
      for (const [label, b] of Object.entries(bridges))
        add(`bridge-${label}`, exercise(`bridge-${label}`, b, round))

      // Two WebSocket clients: the busy one works, the idle one hears nothing.
      add(
        'websocket pair',
        (async () => {
          const busy = await connect(
            new WebSocketClientTransport(new URL(url.ws)),
            'ws-busy',
          )
          const idle = new WebSocket(url.ws)
          const heard: string[] = []
          idle.on('message', (data) => heard.push(String(data)))
          await once(idle, 'open')
          try {
            await exercise('ws', busy, round)
            assert.deepEqual(
              heard,
              [],
              'an idle WebSocket client heard traffic',
            )
          } finally {
            await busy.client.close()
            idle.terminate()
          }
        })(),
      )

      // Fresh SSE and stateful sessions, and stateless requests.
      for (const mode of ['sse', 'stateful'] as const)
        add(
          mode,
          (async () => {
            const transport =
              mode === 'sse'
                ? new SSEClientTransport(new URL(url.sse))
                : new StreamableHTTPClientTransport(new URL(url.stateful))
            const c = await connect(transport, mode)
            try {
              await exercise(mode, c, round)
            } finally {
              if (mode === 'stateful')
                await step('terminate session', () =>
                  (
                    transport as StreamableHTTPClientTransport
                  ).terminateSession(),
                )
              await c.client.close()
            }
          })(),
        )
      if (round % 5 === 0)
        add(
          'stateless large reply',
          (async () => {
            const c = await connect(
              new StreamableHTTPClientTransport(new URL(url.stateless)),
              'stateless',
            )
            try {
              const result = await c.client.callTool(
                { name: 'big', arguments: { bytes: BIG } },
                undefined,
                CALL,
              )
              assert.equal(textOf(result).length, BIG, 'stateless large reply')
            } finally {
              await c.client.close()
            }
          })(),
        )

      // A server crashing mid-call: the caller gets an error, not a hang.
      if (round % 10 === 5)
        add(
          'crashes',
          (async () => {
            for (const [mode, transport] of [
              ['sse', () => new SSEClientTransport(new URL(url.sse))],
              [
                'stateful',
                () => new StreamableHTTPClientTransport(new URL(url.stateful)),
              ],
              ['ws', () => new WebSocketClientTransport(new URL(url.ws))],
            ] as const) {
              const c = await connect(transport(), `crash-${mode}`)
              try {
                await assert.rejects(
                  c.client.callTool(
                    { name: 'crash', arguments: {} },
                    undefined,
                    CALL,
                  ),
                  undefined,
                  `${mode}: a crashed server must fail the call`,
                )
                crashes++
              } finally {
                await c.client.close().catch(() => {})
              }
            }
          })(),
        )

      await Promise.all(work)

      // Restart the gateway behind one bridge; the bridge must carry on.
      if (round > 0 && round % 30 === 0) {
        const behind = restarts % 2 === 0 ? 'stateful' : 'sse'
        const bridge = behind === 'stateful' ? bridges.http : bridges.sse
        await gateways[behind].restart()
        await recovered(`bridge in front of ${behind}`, async () => {
          assert.equal(
            textOf(
              await bridge.client.callTool(
                { name: 'chatty', arguments: { tag: 'after-restart' } },
                undefined,
                { timeout: 5000 },
              ),
            ),
            'chatty:after-restart',
          )
        })
        restarts++
        emit({ phase: 'restarted', round, behind })
      }

      await delay(1000)
      if (++round % 10 === 0) {
        const rows = sample('active', round)
        if (round >= 20) warmSamples.push(rows)
      }
    }
    emit({ phase: 'active-complete', round, restarts, crashes })

    // The bridges' sessions hold one child each on the gateways behind them.
    const beforeClose = sample('bridges-idle', round)
    for (const b of Object.values(bridges)) await b.client.close()
    await delay(15000)
    const settled = sample('cooldown', round, false)
    for (const [index, row] of settled.entries()) {
      if (row.mode.startsWith('bridge-')) continue
      assert.equal(row.children, 0, `${row.mode}: children left behind`)
      assert.ok(
        row.descriptors <= baseline[index].descriptors + 8,
        `${row.mode}: descriptor growth`,
      )
    }
    // RSS: compare a warmed-up sample with the final one, as soak-release does.
    const warm = warmSamples[Math.min(2, warmSamples.length - 1)]
    if (warm)
      for (const [index, row] of beforeClose.entries()) {
        const final = row.mode.startsWith('bridge-') ? row : settled[index]
        assert.ok(
          final.rssKiB <= warm[index].rssKiB * 1.2 + 16 * 1024,
          `${row.mode}: RSS kept growing after warm-up`,
        )
      }
    emit({ phase: 'complete', seconds, round, restarts, crashes })
    console.log(JSON.stringify({ seconds, round, restarts, crashes, report }))
  },
)
