// Repeated checks of an installed public artifact. No publication or credentials.
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createSoakCommandGroup } from './soak-command-group.mjs'

assert.equal(process.env.SUPERGATEWAY_SOAK_CONFIRMED, '1')
const seconds = Number(process.env.SOAK_SECONDS ?? 10800)
assert.ok(Number.isFinite(seconds) && seconds >= 60 && seconds <= 21600)
const entry = resolve(process.env.SUPERGATEWAY_TEST_ENTRY)
const pkg = JSON.parse(
  readFileSync(resolve(entry, '../../package.json'), 'utf8'),
)
assert.equal(pkg.name, 'supergateway')
assert.equal(pkg.version, '4.0.0')
assert.equal(process.env.SOAK_PACKAGE_VERSION, pkg.version)
const artifact = JSON.parse(
  readFileSync(resolve(entry, '../../../../artifact.json'), 'utf8'),
)
assert.equal(artifact.version, pkg.version)
assert.equal(artifact.sha256, process.env.SOAK_PACKAGE_SHA256)
assert.match(artifact.sha256, /^[a-f0-9]{64}$/)
const root = resolve(process.env.SOAK_DIRECTORY ?? '.release/overnight')
mkdirSync(root, { recursive: true })
const started = Date.now()
let deadline = started + seconds * 1000
const events = (event) => {
  const row = { time: new Date().toISOString(), ...event }
  appendFileSync(resolve(root, 'events.jsonl'), JSON.stringify(row) + '\n')
  console.log(JSON.stringify(row))
}
const env = { ...process.env, SUPERGATEWAY_TEST_ENTRY: entry }
const commands = createSoakCommandGroup({ root, events, env })
const { run } = commands
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => commands.cancel(signal, true))
const modern = [
  'modernProtocol',
  'modernTransparency',
  'modernAutoCompatibility',
  'modernHttpSafety',
  'modernRelayEdges',
  'protocolVersionMatrix',
  'modernContinuationBoundary',
]
const portable = [
  'modernContinuation',
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
  // Behaviour new since 4.0.0: what the bridges relay and cancel,
  // per-connection WebSocket children, and the stateless handshake.
  'bridgeServerInitiated',
  'bridgeCancellation',
  'wsClientIdentity',
  'resourcesAndPrompts',
  'statelessProtocolVersion',
  'statelessInitializedNotification',
  'httpResponseHeaders',
  'httpBodyErrors',
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
  sha256: artifact.sha256,
  resourceSoak:
    process.platform !== 'win32' && process.env.SOAK_SKIP_RESOURCE !== '1',
})
writeFileSync(resolve(root, 'pid'), String(process.pid))
async function batteries() {
  let cycle = 0
  do {
    for (let index = 0; index < groups.length; index++) {
      if (commands.failed) return
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
        if (commands.failed) return
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
    await delay(
      Math.min(60000, Math.max(0, deadline - Date.now())),
      undefined,
      { signal: commands.signal },
    )
  } while (Date.now() < deadline && !commands.failed)
}
// One finite default-lifetime check per lane/phase, against the installed CLI.
let preflightError
try {
  await run(
    'continuation-lifetime',
    [
      '--import',
      'tsx',
      '--test',
      '--test-reporter',
      './scripts/release-test-reporter.mjs',
      'scripts/continuation-lifetime.test.ts',
    ],
    9 * 60000,
  )
} catch (error) {
  preflightError = String(error)
}
deadline = Date.now() + seconds * 1000
const jobs = commands.failed ? [] : [batteries()]
if (
  !commands.failed &&
  process.platform !== 'win32' &&
  process.env.SOAK_SKIP_RESOURCE !== '1'
)
  jobs.push(
    run(
      'resources',
      ['--import', 'tsx', 'scripts/soak-release.test.ts'],
      (seconds + 480) * 1000,
      { SOAK_REPORT: resolve(root, 'resources.jsonl') },
    ),
  )
const results = await Promise.allSettled(jobs)
const errors = results
  .filter((result) => result.status === 'rejected')
  .map((result) => String(result.reason))
if (preflightError) errors.unshift(preflightError)
// A cancelled lane is not a passing lane, but it is not evidence against the
// release either: the workflow stopped this runner because a *different* job
// failed, and fail-fast means that job is the one worth reading.
const status = commands.cancelledExternally
  ? 'cancelled'
  : errors.length || commands.failed
    ? 'failed'
    : 'passed'
const summary = {
  status,
  seconds,
  elapsedSeconds: Math.round((Date.now() - started) / 1000),
  errors,
}
writeFileSync(
  resolve(root, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
)
events({ phase: 'complete', ...summary })
process.exitCode = summary.status === 'passed' ? 0 : 1
