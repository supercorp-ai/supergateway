import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'

const rootDir = process.cwd()
const packageJson = JSON.parse(
  readFileSync(join(rootDir, 'package.json'), 'utf-8'),
) as { version: string }

test('--version prints the package version', () => {
  const tsxBin = join(
    rootDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
  )
  const result = spawnSync(tsxBin, ['src/index.ts', '--version'], {
    cwd: rootDir,
    encoding: 'utf-8',
  })

  assert.strictEqual(result.status, 0)
  assert.strictEqual(result.stdout.trim(), packageJson.version)
  assert.doesNotMatch(result.stderr, /You must specify one of/)
})
