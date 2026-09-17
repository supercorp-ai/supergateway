// Opt-in sustained testing of an installed candidate, never part of npm test.
// Only after user confirmation: SUPERGATEWAY_SOAK_CONFIRMED=1
// SOAK_SECONDS=86400 SUPERGATEWAY_TEST_ENTRY=/.../dist/index.js
// node --import tsx --test scripts/soak-release.test.ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { unusedPort } from '../tests/helpers/gateway-process.js'
import type { TestContext } from 'node:test'
import { descendantsOf } from '../tests/helpers/process-tree.js'

assert.equal(
  process.env.SUPERGATEWAY_SOAK_CONFIRMED,
  '1',
  'Soak requires explicit user confirmation; do not start it as part of release preparation',
)
const seconds = Number(process.env.SOAK_SECONDS ?? 600)
assert.ok(Number.isFinite(seconds) && seconds >= 60)
const report = process.env.SOAK_REPORT ?? '.release/soak.jsonl'
mkdirSync(dirname(report), { recursive: true })
const emit = (row: object) =>
  appendFileSync(
    report,
    JSON.stringify({ time: new Date().toISOString(), ...row }) + '\n',
  )
// Keep only a bounded diagnostic tail: the observer must not grow for six hours.
function launchGateway(
  t: TestContext,
  args: string[],
  env: Record<string, string>,
) {
  const child = spawn(
    process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath,
    [process.env.SUPERGATEWAY_TEST_ENTRY!, ...args],
    { stdio: 'pipe', detached: true, env: { ...process.env, ...env } },
  )
  let tail = ''
  for (const stream of [child.stdout, child.stderr])
    stream.setEncoding('utf8').on('data', (chunk) => {
      tail = (tail + chunk).slice(-65536)
    })
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
  emit({ phase: 'gateway-start', pid: child.pid, args })
  t.after(async () => {
    const owned = descendantsOf(child.pid!)
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM')
    await Promise.race([exited, delay(7000, undefined, { ref: false })])
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
    await exited
    for (const pid of owned) {
      const { processInfo } = await import('../tests/helpers/process-tree.js')
      assert.equal(
        processInfo(pid).alive,
        false,
        `owned descendant ${pid} survived shutdown`,
      )
    }
    emit({ phase: 'gateway-stopped', pid: child.pid })
  })
  return {
    child,
    ready: async () => {
      const deadline = Date.now() + 15000
      while (!/Listening on port/.test(tail)) {
        assert.ok(
          child.exitCode === null &&
            child.signalCode === null &&
            Date.now() < deadline,
          tail,
        )
        await delay(25)
      }
    },
  }
}
const modernVersion = '2026-07-28'
test(
  'installed release candidate: calls, reconnects, cancellations and idle resource recovery',
  { timeout: (seconds + 120) * 1000 },
  async (t) => {
    assert.ok(
      process.env.SUPERGATEWAY_TEST_ENTRY,
      'Select the installed artifact explicitly',
    )
    const gateways = []
    for (const mode of ['sse', 'stateful', 'stateless', 'modern']) {
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        [
          '--stdio',
          mode === 'modern'
            ? 'node tests/helpers/modern-bridge-peer.mjs'
            : 'node tests/helpers/mock-mcp-server.js stdio',
          '--outputTransport',
          mode === 'sse' ? 'sse' : 'streamableHttp',
          '--port',
          String(port),
          ...(mode === 'stateful' ? ['--stateful'] : []),
        ],
        mode === 'modern' ? { MODERN_WIRE: '1' } : {},
      )
      await gateway.ready()
      gateways.push({
        mode,
        gateway,
        url: `http://127.0.0.1:${port}/${mode === 'sse' ? 'sse' : 'mcp'}`,
      })
    }
    function sample(phase: string, round: number) {
      const rows = gateways.map(({ mode, gateway }) => {
        const pid = gateway.child.pid!
        const rssKiB = Number(
          execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
            encoding: 'utf8',
          }).trim(),
        )
        assert.ok(rssKiB > 0)
        const descriptors =
          process.platform === 'linux'
            ? readdirSync(`/proc/${pid}/fd`).length
            : execFileSync('lsof', ['-p', String(pid), '-Ff'], {
                encoding: 'utf8',
              })
                .split('\n')
                .filter((line) => /^f\d/.test(line)).length
        return {
          mode,
          rssKiB,
          descriptors,
          children: descendantsOf(pid).length,
        }
      })
      emit({
        phase,
        round,
        rows,
        observerRssKiB: Math.round(process.memoryUsage().rss / 1024),
      })
      return rows
    }
    let id = 0,
      calls = 0,
      cancellations = 0,
      connections = 0
    async function roundTrip({ mode, url }: (typeof gateways)[number]) {
      if (mode === 'modern') {
        const post = (name: string, signal: AbortSignal) =>
          fetch(url, {
            method: 'POST',
            signal,
            headers: {
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
              'mcp-protocol-version': modernVersion,
              'mcp-method': 'tools/call',
              'mcp-name': name,
              ...(name === 'echo'
                ? {
                    'mcp-param-value': `=?base64?${Buffer.from(`soak Unicode 🌙 漢字 \u2028 ${id + 1}`).toString('base64')}?=`,
                  }
                : {}),
            },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: ++id,
              method: 'tools/call',
              params: {
                name,
                arguments: { value: `soak Unicode 🌙 漢字 \u2028 ${id}` },
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': modernVersion,
                  'io.modelcontextprotocol/clientInfo': {
                    name: 'soak',
                    version: '1',
                  },
                  'io.modelcontextprotocol/clientCapabilities': {},
                  progressToken: 'soak',
                },
              },
            }),
          })
        const expected = `soak Unicode 🌙 漢字 \u2028 ${id + 1}`
        const result = await post('echo', AbortSignal.timeout(10000))
        const body = await result.text()
        assert.equal(result.status, 200, body)
        const messages = body
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5)))
        const message =
          messages.find((message) => message.result) ?? JSON.parse(body)
        assert.deepEqual(message.result.content, [
          { type: 'text', text: expected },
        ])
        assert.deepEqual(message.result.structuredContent, { value: expected })
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), 10000)
        try {
          const waiting = await post('wait', abort.signal)
          assert.equal(waiting.status, 200)
          const reader = waiting.body!.getReader()
          const first = await reader.read()
          assert.match(
            new TextDecoder().decode(first.value),
            /notifications\/progress/,
          )
          abort.abort()
          await reader.cancel().catch(() => {})
          cancellations++
        } finally {
          clearTimeout(timer)
          abort.abort()
        }
        calls++
        return
      }
      const client = new Client({ name: 'soak', version: '1' })
      const transport =
        mode === 'sse'
          ? new SSEClientTransport(new URL(url))
          : new StreamableHTTPClientTransport(new URL(url))
      try {
        await client.connect(transport)
        connections++
        assert.equal((await client.listTools()).tools[0].name, 'add')
        for (let n = 0; n < 3; n++) {
          const result = await client.callTool({
            name: 'add',
            arguments: { a: n, b: 42 - n },
          })
          assert.deepEqual(result.content, [
            { type: 'text', text: `The sum of ${n} and ${42 - n} is 42.` },
          ])
          calls++
        }
      } finally {
        // HTTP response completion does not end a stateful MCP session.
        if (mode === 'stateful')
          await (transport as StreamableHTTPClientTransport).terminateSession()
        await client.close()
      }
    }
    emit({
      phase: 'start',
      seconds,
      entry: process.env.SUPERGATEWAY_TEST_ENTRY,
      runtime: process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath,
    })
    const baseline = sample('baseline', 0)
    const deadline = Date.now() + seconds * 1000
    let round = 0
    const activeSamples: ReturnType<typeof sample>[] = []
    while (Date.now() < deadline) {
      const concurrency = round % 120 >= 100 ? 4 : 2
      const work = Promise.all(
        gateways.map(async (gateway) => {
          // Repeated independent connections exercise setup and teardown; calls within
          // each stateful connection must retain its session until explicit DELETE.
          await Promise.all(
            Array.from({ length: concurrency }, () => roundTrip(gateway)),
          )
        }),
      )
      let timer: NodeJS.Timeout | undefined
      try {
        await Promise.race([
          work,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(Error('Soak round exceeded 60 seconds')),
              60000,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
      await delay(1000)
      if (round > 0 && round % 120 === 0) {
        await delay(10000)
        emit({ phase: 'idle-window', round, calls, cancellations, connections })
      }
      if (++round % 10 === 0) {
        const rows = sample('active', round)
        activeSamples.push(rows)
        for (const row of rows)
          assert.ok(
            row.children <= (row.mode === 'sse' ? 2 : 0),
            `${row.mode}: children failed to settle`,
          )
      }
    }
    const settled = []
    for (let n = 0; n < 6; n++) {
      await delay(5000)
      settled.push(sample('cooldown', round))
    }
    for (const [index, row] of settled.at(-1)!.entries()) {
      assert.equal(
        row.children,
        row.mode === 'sse' ? baseline[index].children : 0,
      )
      assert.ok(
        row.descriptors <= baseline[index].descriptors + 8,
        `${row.mode}: descriptor growth`,
      )
      // RSS includes allocator retention. Compare a warmed-up sample to the final
      // idle sample; retain all observations for longer-run trend review.
      const warm = activeSamples[Math.floor(activeSamples.length / 2)]?.[index]
      if (warm)
        assert.ok(
          row.rssKiB <= warm.rssKiB * 1.2 + 16 * 1024,
          `${row.mode}: RSS kept growing after warm-up`,
        )
    }
    emit({
      phase: 'complete',
      seconds,
      round,
      calls,
      cancellations,
      connections,
    })
    console.log(
      JSON.stringify({
        seconds,
        round,
        calls,
        cancellations,
        connections,
        report,
      }),
    )
  },
)
