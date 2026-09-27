// Opt-in: the Python, Go and Ruby battery drivers against an installed
// candidate for the whole soak, never part of npm test. The exercise lanes run
// only the Node driver each cycle. These are independent implementations, with
// their own JSON encoders and SSE parsers (tests/clients/README.md), so an
// assumption the gateway shares with the Node SDK can still surface here, and
// hours of load is when it would.
//
// Each cycle runs every driver over every output transport through
// tests/clients/run-battery.mjs. The first failure stops the soak and names its
// cycle and driver; each battery's log and report are kept.
//
// Only after user confirmation: SUPERGATEWAY_SOAK_CONFIRMED=1 SOAK_SECONDS=600
// SUPERGATEWAY_TEST_ENTRY=/.../dist/index.js SOAK_BATTERY_PYTHON=/.../pybattery
// SOAK_BATTERY_GO=/.../go-battery SOAK_BATTERY_RUBY=/.../rbbattery
// node scripts/soak-languages.mjs
import assert from 'node:assert/strict'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { createSoakCommandGroup } from './soak-command-group.mjs'

assert.equal(
  process.env.SUPERGATEWAY_SOAK_CONFIRMED,
  '1',
  'Soak requires explicit user confirmation; do not start it as part of release preparation',
)
const seconds = Number(process.env.SOAK_SECONDS ?? 10800)
assert.ok(Number.isFinite(seconds) && seconds >= 60 && seconds <= 21600)
assert.ok(
  process.env.SUPERGATEWAY_TEST_ENTRY,
  'SUPERGATEWAY_TEST_ENTRY must name the installed candidate',
)
const entry = resolve(process.env.SUPERGATEWAY_TEST_ENTRY)
const drivers = Object.entries({
  python: process.env.SOAK_BATTERY_PYTHON,
  go: process.env.SOAK_BATTERY_GO,
  ruby: process.env.SOAK_BATTERY_RUBY,
})
for (const [driver, binary] of drivers)
  assert.ok(
    binary,
    `SOAK_BATTERY_${driver.toUpperCase()} must name the ${driver} driver`,
  )
const root = resolve(process.env.SOAK_DIRECTORY ?? '.release/languages')
mkdirSync(root, { recursive: true })
const started = Date.now()
const deadline = started + seconds * 1000
const events = (event) => {
  const row = { time: new Date().toISOString(), ...event }
  appendFileSync(resolve(root, 'events.jsonl'), JSON.stringify(row) + '\n')
  console.log(JSON.stringify(row))
}
const commands = createSoakCommandGroup({
  root,
  events,
  env: { ...process.env, SUPERGATEWAY_TEST_ENTRY: entry },
})
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => commands.cancel(signal, true))

events({
  phase: 'start',
  seconds,
  entry,
  drivers: drivers.map(([driver]) => driver),
  runtime: process.version,
  platform: process.platform,
})
let cycle = 0
let error
try {
  // Always complete one full cycle, even in a short harness canary.
  do {
    for (const [driver, binary] of drivers)
      await commands.run(
        `cycle-${cycle}-${driver}`,
        ['tests/clients/run-battery.mjs', driver, binary],
        6 * 60000,
        { BATTERY_REPORT: resolve(root, `cycle-${cycle}-${driver}.json`) },
      )
    events({ phase: 'cycle-complete', cycle: cycle++ })
    await delay(
      Math.min(10000, Math.max(0, deadline - Date.now())),
      undefined,
      { signal: commands.signal },
    ).catch(() => {})
  } while (Date.now() < deadline && !commands.failed)
} catch (caught) {
  error = String(caught)
}
// As in overnight-release.mjs: a runner stopped because another job failed is
// not a passing lane, but it is not evidence against the release either.
const status = commands.cancelledExternally
  ? 'cancelled'
  : error || commands.failed
    ? 'failed'
    : 'passed'
const summary = {
  status,
  seconds,
  elapsedSeconds: Math.round((Date.now() - started) / 1000),
  cycles: cycle,
  errors: error ? [error] : [],
}
writeFileSync(
  resolve(root, 'summary.json'),
  JSON.stringify(summary, null, 2) + '\n',
)
events({ phase: 'complete', ...summary })
process.exitCode = status === 'passed' ? 0 : 1
