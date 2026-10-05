#!/usr/bin/env node
// A released version's own end-to-end tests, run against this build.
//
// The tests of a release say what that release promised a client. They start
// the gateway through SUPERGATEWAY_TEST_ENTRY, so the same tests, unchanged,
// can be pointed at this build: every one that passed then must pass now.
// The ones meant to fail now, because this build changed that behaviour on
// purpose, are listed with their reason in tests/releasedTests.intended.json.
// A failure that is not listed fails this script, and so does a listed test
// that passes.
//
// Usage: node scripts/released-tests.mjs [version] [part of a file name]
// Without a version, every release in tests/crossVersion.baselines.json. With
// part of a file name, only the test files whose name has it.
// Needs the tag v<version> (it is fetched if absent) and the network, for the
// release's own dependencies. `npm run build` first; `npm run test:released`
// does both.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const versions = process.argv[2]
  ? [process.argv[2]]
  : Object.keys(
      JSON.parse(readFileSync('tests/crossVersion.baselines.json', 'utf8')),
    )
const only = process.argv[3] ?? ''
const entry = resolve(process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js')
assert.ok(existsSync(entry), `${entry} does not exist: npm run build`)
const everyIntended = JSON.parse(
  readFileSync('tests/releasedTests.intended.json', 'utf8'),
)
const reporter = resolve('scripts/released-tests-reporter.mjs')

const git = (...args) => execFileSync('git', args, { stdio: 'pipe' })
function check(version) {
  assert.match(version, /^\d+\.\d+\.\d+$/, `Not a version: ${version}`)
  const root = resolve('.baselines', `tests-${version}`)
  const intended = everyIntended[version] ?? {}
  if (!existsSync(join(root, 'package.json'))) {
    mkdirSync(root, { recursive: true })
    try {
      git('rev-parse', '--verify', `v${version}^{commit}`)
    } catch {
      git('fetch', '--depth', '1', 'origin', 'tag', `v${version}`)
    }
    const archive = join(root, 'source.tar')
    git('archive', '--output', archive, `v${version}`)
    execFileSync('tar', ['-xf', archive, '-C', root])
    // The release is built too: a few of its tests start `dist/index.js` by
    // that name, as the server behind the gateway under test or as a library.
    for (const args of [
      ['ci', '--no-audit', '--no-fund', '--ignore-scripts'],
      ['run', 'build'],
    ])
      execFileSync('npm', args, {
        cwd: root,
        stdio: 'inherit',
        shell: process.platform === 'win32',
      })
  }

  // The files that start the gateway they test. The others test the release's
  // own source, which is not what is being asked here.
  const files = readdirSync(join(root, 'tests'))
    .filter((name) => name.endsWith('.test.ts'))
    .filter((name) => name.includes(only))
    .map((name) => `tests/${name}`)
    .filter((file) =>
      /gateway-process|SUPERGATEWAY_TEST_ENTRY/.test(
        readFileSync(join(root, file), 'utf8'),
      ),
    )
    .sort()

  function run(selected) {
    const { stdout, status } = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--test',
        '--test-concurrency=1',
        '--test-timeout=120000',
        '--experimental-test-module-mocks',
        `--test-reporter=${reporter}`,
        '--test-reporter-destination=stdout',
        ...selected,
      ],
      {
        cwd: root,
        env: { ...process.env, SUPERGATEWAY_TEST_ENTRY: entry },
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    const results = stdout
      .split('\n')
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
    assert.ok(results.length > 0, `No test ran (exit ${status})`)
    return results
  }

  const key = ({ file, name }) => `${file}: ${name}`
  console.log(
    `${version}: ${files.length} end-to-end test files against ${entry}`,
  )
  const first = run(files)
  const failed = new Set(first.filter((test) => !test.passed).map(key))

  // A released test that fails once under load and passes alone is the test's
  // own timing, not this build: only what fails twice counts.
  const unexpected = [...failed].filter((name) => !(name in intended))
  if (unexpected.length > 0) {
    const again = [
      ...new Set(
        first
          .filter((test) => unexpected.includes(key(test)))
          .map((test) => test.file),
      ),
    ]
    console.log(`Running again: ${again.join(', ')}`)
    const second = new Map(run(again).map((test) => [key(test), test.passed]))
    for (const name of unexpected)
      if (second.get(name)) {
        failed.delete(name)
        console.log(`Passed the second time: ${name}`)
      }
  }

  const problems = [
    ...[...failed]
      .filter((name) => !(name in intended))
      .map((name) => `FAILS, and is not an intended change: ${name}`),
    ...Object.keys(intended)
      .filter((name) => files.some((file) => name.startsWith(`${file}: `)))
      .filter((name) => !failed.has(name))
      .map(
        (name) =>
          `PASSES (or no longer runs), but is listed as an intended change: ${name}`,
      ),
  ]
  console.log(
    `${first.length} tests ran: ${first.length - failed.size} pass, ${failed.size} fail, ${Object.keys(intended).length} intended to fail.`,
  )
  for (const problem of problems) console.error(problem)
  return problems.length
}

let failures = 0
for (const version of versions) failures += check(version)
process.exit(failures ? 1 : 0)
