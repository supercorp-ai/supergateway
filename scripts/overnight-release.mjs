// Repeated checks of an installed public artifact. No publication or credentials.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  createWriteStream,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.env.SUPERGATEWAY_SOAK_CONFIRMED, '1')
const seconds = Number(process.env.SOAK_SECONDS ?? 10800)
assert.ok(Number.isFinite(seconds) && seconds >= 60 && seconds <= 21600)
const entry = resolve(process.env.SUPERGATEWAY_TEST_ENTRY)
const pkg = JSON.parse(
  readFileSync(resolve(entry, '../../package.json'), 'utf8'),
)
assert.equal(pkg.name, 'supergateway')
assert.equal(pkg.version, '4.0.0-rc.0')
const root = resolve(process.env.SOAK_DIRECTORY ?? '.release/overnight')
mkdirSync(root, { recursive: true })
const started = Date.now()
const deadline = started + seconds * 1000
const events = (event) => {
  const row = { time: new Date().toISOString(), ...event }
  appendFileSync(resolve(root, 'events.jsonl'), JSON.stringify(row) + '\n')
  console.log(JSON.stringify(row))
}
let failed = false
const env = { ...process.env, SUPERGATEWAY_TEST_ENTRY: entry }
async function run(name, args, timeout, extra = {}) {
  const log = createWriteStream(resolve(root, `${name}.log`))
  const child = spawn(process.execPath, args, {
    env: { ...env, ...extra },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log, { end: false })
  child.stderr.pipe(log, { end: false })
  events({ phase: 'start-command', name, pid: child.pid })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, timeout)
  // A hung subprocess is a failure, not an unbounded overnight wait.
  const hardTimer = setTimeout(() => child.kill('SIGKILL'), timeout + 15000)
  const result = await new Promise((ok) => {
    child.once('error', (error) => ok({ code: null, error: String(error) }))
    child.once('close', (code, signal) => ok({ code, signal }))
  })
  clearTimeout(timer)
  clearTimeout(hardTimer)
  await new Promise((ok) => log.end(ok))
  events({ phase: 'end-command', name, ...result, timedOut })
  if (result.code !== 0 || timedOut) {
    failed = true
    throw Error(`${name} failed; inspect ${root}/${name}.log`)
  }
}
const modern = [
  'modernProtocol',
  'modernTransparency',
  'modernAutoCompatibility',
  'modernHttpSafety',
  'modernRelayEdges',
  'protocolVersionMatrix',
]
const portable = [
  'gatewayE2e',
  'bridgeResultE2e',
  'bridgeWireResponsesE2e',
  'bridgePipeliningE2e',
  'headerNamesE2e',
  'credentialHeaders',
  'serverInitiated',
  'statefulSessionContinuityE2e',
  'sseReconnect',
  'sseDisconnectSurvival',
  'statelessNotificationsE2e',
  'utf8ChunkBoundariesE2e',
]
const lifecycle = [
  'ownedProcessGroupsE2e',
  'parentOnlyShutdownE2e',
  'sessionProcessExitE2e',
  'httpChildExitSdkE2e',
  'httpChildIoSdkE2e',
  'statefulStaleReplyE2e',
  'statelessLifetimeE2e',
  'sessionRaceOrdersE2e',
  'httpDisconnectRegressionE2e',
]
const groups =
  process.platform === 'win32' ? [modern] : [modern, portable, lifecycle]
events({
  phase: 'start',
  seconds,
  entry,
  version: pkg.version,
  runtime: process.version,
  platform: process.platform,
  arch: process.arch,
  groups,
  resourceSoak:
    process.platform !== 'win32' && process.env.SOAK_SKIP_RESOURCE !== '1',
})
writeFileSync(resolve(root, 'pid'), String(process.pid))
async function batteries() {
  let cycle = 0
  do {
    for (let index = 0; index < groups.length; index++) {
      if (failed) return
      // Always complete one scenario pass, even in a short harness canary.
      if (cycle > 0 && Date.now() >= deadline) return
      await run(
        `cycle-${cycle}-group-${index}`,
        [
          '--import',
          'tsx',
          '--test',
          '--test-concurrency=1',
          '--test-reporter',
          './scripts/release-test-reporter.mjs',
          ...groups[index].map((name) => `tests/${name}.test.ts`),
        ],
        12 * 60000,
      )
    }
    if (process.platform !== 'win32') {
      for (const old of [false, true]) {
        if (failed) return
        await run(
          `cycle-${cycle}-sdk-${old ? '1.4' : '1.30'}`,
          ['tests/clients/run-battery.mjs', 'node'],
          6 * 60000,
          {
            BATTERY_REPORT: resolve(
              root,
              `cycle-${cycle}-sdk-${old ? '1.4' : '1.30'}.json`,
            ),
            ...(old
              ? {
                  BATTERY_SDK: 'prev-modelcontextprotocol-sdk',
                  BATTERY_MODES: 'sse',
                }
              : {}),
          },
        )
      }
    }
    events({ phase: 'cycle-complete', cycle: cycle++ })
    await delay(Math.min(60000, Math.max(0, deadline - Date.now())))
  } while (Date.now() < deadline && !failed)
}
const jobs = [batteries()]
if (process.platform !== 'win32' && process.env.SOAK_SKIP_RESOURCE !== '1')
  jobs.push(
    run(
      'resources',
      ['--import', 'tsx', 'scripts/soak-release.test.ts'],
      (seconds + 180) * 1000,
      { SOAK_REPORT: resolve(root, 'resources.jsonl') },
    ),
  )
const results = await Promise.allSettled(jobs)
const errors = results
  .filter((result) => result.status === 'rejected')
  .map((result) => String(result.reason))
const summary = {
  status: errors.length ? 'failed' : 'passed',
  seconds,
  elapsedSeconds: Math.round((Date.now() - started) / 1000),
  errors,
}
writeFileSync(
  resolve(root, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
)
events({ phase: 'complete', ...summary })
process.exitCode = errors.length ? 1 : 0
