// The soak campaign's result: its phases no longer depend on each other's
// success, so this fails if any phase failed or was cancelled, and says which.
// Reads the workflow's `needs` context as JSON from NEEDS.
import { appendFileSync } from 'node:fs'

const needs = JSON.parse(process.env.NEEDS ?? '{}')
const rows = Object.entries(needs).map(
  ([phase, { result }]) => `| ${phase} | ${result} |`,
)
const failed = Object.entries(needs)
  .filter(([, { result }]) => result === 'failure' || result === 'cancelled')
  .map(([phase]) => phase)
const summary = [
  '| Phase | Result |',
  '|---|---|',
  ...rows,
  '',
  failed.length
    ? `**${failed.length} phase(s) did not pass:** ${failed.join(', ')}. ` +
      'To check their failed lanes again, run a fresh `five-hours` campaign: ' +
      'rerunning the failed jobs of this one reruns every later phase in full.'
    : 'Every phase that ran passed.',
].join('\n')
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + '\n')
console.log(summary)
process.exitCode = failed.length ? 1 : 0
