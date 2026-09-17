// Run the same CLI tests and SDK client configurations against three artifacts.
// Baseline failures are recorded, never silently allowed as candidate failures.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  mkdirSync,
  createWriteStream,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { resolve } from 'node:path'

const [published, main, candidate, destination = '.release/comparison'] =
  process.argv.slice(2)
assert.ok(
  published && main && candidate,
  'Usage: node scripts/compare-release.mjs <3.4.3-entry> <main-entry> <candidate-entry> [output-dir]',
)
mkdirSync(destination, { recursive: true })
const files = [
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
  'ownedProcessGroupsE2e',
  'utf8ChunkBoundariesE2e',
  'protocolVersionMatrix',
]
const results = []
for (const [label, entry] of Object.entries({ published, main, candidate })) {
  const env = { ...process.env, SUPERGATEWAY_TEST_ENTRY: resolve(entry) }
  async function run(name, args, extra = {}) {
    const log = createWriteStream(resolve(destination, `${label}-${name}.log`))
    const proc = spawn(process.execPath, args, {
      env: { ...env, ...extra },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    proc.stdout.pipe(log, { end: false })
    proc.stderr.pipe(log, { end: false })
    const code = await new Promise((ok, reject) => {
      proc.once('error', reject)
      proc.once('close', ok)
    })
    await new Promise((ok) => log.end(ok))
    results.push({ label, name, code })
    console.log(`${label} ${name}: exit ${code}`)
  }
  await run('behavior', [
    '--import',
    'tsx',
    '--test',
    '--test-concurrency=1',
    '--test-reporter',
    './scripts/release-test-reporter.mjs',
    ...files.map((f) => `tests/${f}.test.ts`),
  ])
  await run('sdk130', ['tests/clients/run-battery.mjs', 'node'], {
    BATTERY_REPORT: resolve(destination, `${label}-sdk130.json`),
  })
  await run('sdk14', ['tests/clients/run-battery.mjs', 'node'], {
    BATTERY_SDK: 'prev-modelcontextprotocol-sdk',
    BATTERY_MODES: 'sse',
    BATTERY_REPORT: resolve(destination, `${label}-sdk14.json`),
  })
}
const outcomes = Object.fromEntries(
  ['published', 'main', 'candidate'].map((label) => [
    label,
    readFileSync(resolve(destination, `${label}-behavior.log`), 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          const row = JSON.parse(line)
          return row.name && !row.skip && !row.todo ? [row] : []
        } catch {
          return []
        }
      }),
  ]),
)
const differences = outcomes.candidate.flatMap((row) => {
  const controls = ['published', 'main'].map((label) => ({
    label,
    outcome:
      outcomes[label].find((r) => r.name === row.name)?.type ?? 'missing',
  }))
  return controls.some((c) => c.outcome !== row.type)
    ? [
        {
          name: row.name,
          candidate: row.type,
          controls,
          disposition: 'REQUIRES REVIEW',
        },
      ]
    : []
})
writeFileSync(
  resolve(destination, 'summary.json'),
  JSON.stringify({ results, differences }, null, 2) + '\n',
)
assert.ok(
  results.filter((r) => r.label === 'candidate').every((r) => r.code === 0),
  'Candidate checks failed; inspect reports',
)
console.log(
  `${differences.length} behavioral differences require a documented disposition before release.`,
)
