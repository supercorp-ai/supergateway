#!/usr/bin/env node
// Fails the build unless every structural coverage metric is at 100%.
//
// The repository reached 100% on 2026-09-15 and the point of this gate is to
// keep it there, because the number only ever moves one way without one: a
// change adds an obligation, the percentage drops a little, and nobody is
// obliged to notice. Every defect in the backlog hid in a path no test
// exercised.
//
// Assertion coverage is deliberately NOT gated here. It is the one metric that
// needs the authored map in `.supercov/`, which self-ignores and is not in the
// repository, so CI has nothing to measure it against and would read ~0%. It is
// measured locally and quoted in the pull request instead, until the map has
// somewhere to live.
//
// MC/DC is gated rather than left advisory because it is the only metric that
// has ever predicted anything here: calibrated against six condition-level
// mutants, every condition it flagged had a surviving mutant, while lines and
// assertions distinguished none of them.
import { execFileSync } from 'node:child_process'

const SUPERCOV = process.env.SUPERCOV_SPEC ?? 'supercov@0.0.53'

// Pinned on purpose. An engine upgrade has twice changed what the same source
// measures — 0.0.53 fixed a branch outcome that 0.0.52 reported unobserved while
// crediting its own body — so the version that defines "100%" is a decision, not
// whatever npm resolves on the day.
const raw = execFileSync('npx', ['-y', SUPERCOV, 'runs', 'latest', '--json'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
const report = JSON.parse(raw)
const data = report.data ?? report
const coverage = data.coverage

if (!coverage) {
  console.error('No coverage in the latest run. Did the measuring step run?')
  process.exit(1)
}

// `conditions` is MC/DC: a condition counts only once a witness pair shows it
// independently deciding its decision, which is why it is reported apart from
// branch outcomes.
const metrics = [
  ['Lines', coverage.lines],
  ['Statements', coverage.statements],
  ['Functions', coverage.functions],
  ['Branches', coverage.branches],
  ['Decision outcomes', coverage.decisionOutcomes],
  ['Condition outcomes', coverage.conditionOutcomes],
  ['Value selections', coverage.valueSelections],
  [
    'MC/DC conditions',
    {
      covered: coverage.coveredConditions,
      total: coverage.conditions,
      percentage: coverage.conditionCoveragePct,
    },
  ],
]

const failures = []
for (const [name, metric] of metrics) {
  if (!metric || typeof metric.percentage !== 'number') {
    failures.push(`${name}: not reported`)
    continue
  }
  const line = `${name.padEnd(20)} ${String(metric.percentage).padStart(6)}%  (${metric.covered}/${metric.total})`
  if (metric.percentage < 100) {
    failures.push(line)
    console.error(`FAIL  ${line}`)
  } else {
    console.log(`ok    ${line}`)
  }
}

// A run that did not finish can report 100% of what it managed to see.
if (data.testExitCode !== 0) {
  failures.push(`the measured test command exited ${data.testExitCode}`)
}
if (coverage.coverageComplete === false) {
  failures.push('the run reports its coverage as incomplete')
}

if (failures.length > 0) {
  console.error(
    `\n${failures.length} coverage gate failure(s). Inspect with:\n` +
      `  npx ${SUPERCOV} runs latest gaps\n` +
      `  npx ${SUPERCOV} runs latest file <path>\n`,
  )
  process.exit(1)
}
console.log('\nEvery structural coverage metric is at 100%.')
