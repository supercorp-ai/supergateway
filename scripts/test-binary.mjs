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

const others =
  /SUPERGATEWAY_TEST_ENTRY|SUPERGATEWAY_TEST_NODE|dist\/index\.js|mock\.module|observeGateway/
const files = readdirSync(join(repository, 'tests'))
  .filter((name) => name.endsWith('.test.ts'))
  .map((name) => join('tests', name))
  .filter((file) => {
    const source = readFileSync(join(repository, file), 'utf8')
    return source.includes('launchGateway') && !others.test(source)
  })
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
