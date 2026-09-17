// Runs one battery driver against every output transport and fails the process
// if any scenario fails.
//
// Usage: node tests/clients/run-battery.mjs <driver> [binary]
//   driver: node | python | go | ruby
//   binary: executable for the non-node drivers
//
// The gateway is launched with a retry, because asking the OS for a free port
// and then handing it to a child leaves a window in which something else can
// take it. That race produced two false "gateway died" findings before it was
// fixed here; a crash caused by a *request* happens after startup, so retrying
// startup cannot mask one.
import { spawn } from 'node:child_process'
import net from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { execFileSync } from 'node:child_process'

const DRIVER = process.argv[2]
const BIN = process.argv[3]
const PEER = process.env.BATTERY_PEER ?? 'node tests/clients/battery-peer.mjs'

// Deliberately below the smallest limit any SDK imposes on a single SSE event
// (1 MiB, in the Python and Go clients). Sizes at or above it are an
// interoperability question rather than a conformance one — see GW-023 — and
// this job is here to catch regressions, not to re-litigate that.
const BIG_LENGTH = process.env.BIG_LENGTH ?? '524288'

const freePort = () =>
  new Promise((r) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => r(p))
    })
  })

async function launch(args) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    const port = await freePort()
    const gw = spawn(
      process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath,
      [
        process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js',
        ...args.map((a) => (a === '$PORT' ? String(port) : a)),
      ],
      { stdio: 'pipe', detached: true, env: { ...process.env, BIG_LENGTH } },
    )
    let out = ''
    gw.stdout.setEncoding('utf8').on('data', (c) => (out += c))
    gw.stderr.setEncoding('utf8').on('data', (c) => (out += c))
    const alive = () => gw.exitCode === null && gw.signalCode === null
    const closed = new Promise((resolve) => gw.once('close', resolve))
    const stop = async () => {
      // Stdio children own separate groups; allow the gateway to drain them.
      if (alive()) gw.kill('SIGTERM')
      await Promise.race([closed, delay(6500, undefined, { ref: false })])
      if (alive()) {
        try {
          process.kill(-gw.pid, 'SIGKILL')
        } catch {}
        await closed
      }
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline && alive() && !/listening/i.test(out))
      await new Promise((r) => setTimeout(r, 60))
    if (alive() && /listening/i.test(out)) {
      await new Promise((r) => setTimeout(r, 300))
      return { port, stop, out: () => out }
    }
    await stop()
  }
  throw new Error('gateway never started')
}

const MODES = (process.env.BATTERY_MODES ?? 'stateful,stateless,sse').split(',')
const report = []
let failures = 0

for (const mode of MODES) {
  const args = ['--stdio', PEER, '--port', '$PORT']
  if (mode === 'sse') args.push('--outputTransport', 'sse')
  else if (mode === 'stateful')
    args.push('--outputTransport', 'streamableHttp', '--stateful')
  else args.push('--outputTransport', 'streamableHttp')

  const gateway = await launch(args)
  const url =
    mode === 'sse'
      ? `http://127.0.0.1:${gateway.port}/sse`
      : `http://127.0.0.1:${gateway.port}/mcp`
  const kind = mode === 'sse' ? 'sse' : 'http'

  let rows
  try {
    const out =
      DRIVER === 'node'
        ? execFileSync('node', ['tests/clients/battery.mjs', url, kind], {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, BIG_LENGTH },
          })
        : execFileSync(BIN, [url, kind], {
            encoding: 'utf8',
            timeout: 120000,
            maxBuffer: 64 * 1024 * 1024,
            env: { ...process.env, BIG_LENGTH },
          })
    rows = JSON.parse(out.trim().split('\n').pop())
  } catch (e) {
    rows = [
      {
        name: 'driver',
        ok: false,
        detail: String(e.stdout || e.message).slice(0, 200),
      },
    ]
  }

  report.push({ mode, driver: DRIVER, rows })
  const bad = rows.filter((r) => !r.ok)
  failures += bad.length
  console.log(
    `${DRIVER} / ${mode}: ${rows.length - bad.length}/${rows.length} scenarios passed`,
  )
  for (const r of bad) console.log(`  FAIL ${r.name}: ${r.detail}`)
  await gateway.stop()
}

if (process.env.BATTERY_REPORT) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(
    process.env.BATTERY_REPORT,
    JSON.stringify(report, null, 2) + '\n',
  )
}

if (failures > 0) {
  console.error(`\n${DRIVER}: ${failures} scenario failure(s)`)
  process.exit(1)
}
console.log(`\n${DRIVER}: every scenario passed on every transport.`)
