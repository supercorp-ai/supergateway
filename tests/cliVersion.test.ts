import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

test('CLI version belongs to the installed gateway with hoisted dependencies', (t) => {
  // Keep copied code in the project so subprocess coverage loaders can follow it.
  mkdirSync(resolve('.release'), { recursive: true })
  const fixture = mkdtempSync(resolve('.release/gateway-version-'))
  t.after(() => rmSync(fixture, { recursive: true, force: true }))
  const installed = join(fixture, 'gateway')
  mkdirSync(installed)
  cpSync(resolve('dist'), join(installed, 'dist'), { recursive: true })
  writeFileSync(
    join(installed, 'package.json'),
    JSON.stringify({ name: 'supergateway', version: '7.2.1', type: 'module' }),
  )
  writeFileSync(
    join(fixture, 'package.json'),
    JSON.stringify({ name: 'consumer', version: '99.88.77' }),
  )
  symlinkSync(
    resolve('node_modules'),
    join(fixture, 'node_modules'),
    'junction',
  )
  const output = execFileSync(
    process.execPath,
    [join(installed, 'dist/index.js'), '--version'],
    { cwd: fixture, encoding: 'utf8', timeout: 10000 },
  )
  assert.equal(output.trim(), '7.2.1')
})
