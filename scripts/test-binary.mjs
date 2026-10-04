#!/usr/bin/env node
// Run the end-to-end tests against a standalone executable (#50).
//
// A test file qualifies when it starts the gateway only through
// launchGateway, which runs SUPERGATEWAY_TEST_BINARY in place of
// `node dist/index.js`. Files that start it another way (their own spawn, a
// path to dist/, a mocked module) test the npm package, not this.
//
// Usage: node scripts/test-binary.mjs <path to the executable>
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '..')
const binary = process.argv[2] && resolve(process.argv[2])
if (!binary) {
  console.error('Usage: node scripts/test-binary.mjs <path to the executable>')
  process.exit(1)
}

// A test that preloads a module into the gateway (probe-retention patches a
// class of dist/ to count what the garbage collector reclaims) tests the
// package's module graph too: an executable is one file with nothing to
// patch, and its NODE_OPTIONS would reach the server it starts.
const others =
  /SUPERGATEWAY_TEST_ENTRY|SUPERGATEWAY_TEST_NODE|dist\/index\.js|mock\.module|observeGateway|probe-retention/
const files = readdirSync(join(repository, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('tests', name))
  .filter((file) => {
    const source = readFileSync(join(repository, file), 'utf8')
    return source.includes('launchGateway') && !others.test(source)
  })
// Windows runs the set that main CI's packaged tests and the soak's Windows
// lanes run against the npm package (scripts/test-package.mjs,
// scripts/overnight-release.mjs): the rest of the suite is POSIX-only (`exec`
// in shell command lines, process groups) and runs on Linux and macOS.
const windows = new Set([
  'modernProtocol',
  'modernTransparency',
  'modernAutoCompatibility',
  'modernHttpSafety',
  'modernRelayEdges',
  'modernContinuationBoundary',
  'protocolVersionMatrix',
])
if (process.platform === 'win32')
  files.splice(
    0,
    files.length,
    ...files.filter((file) =>
      windows.has(file.replace(/^tests[\\/]/, '').replace(/\.test\.ts$/, '')),
    ),
  )
if (!files.length) {
  console.error('No test files start the gateway through launchGateway.')
  process.exit(1)
}
console.log(`${files.length} test files against ${binary}`)

const { status } = spawnSync(
  process.execPath,
  ['--import', 'tsx', '--test', '--test-concurrency=1', ...files],
  {
    cwd: repository,
    stdio: 'inherit',
    env: { ...process.env, SUPERGATEWAY_TEST_BINARY: binary },
  },
)
process.exit(status ?? 1)
