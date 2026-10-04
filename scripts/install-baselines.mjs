#!/usr/bin/env node
// Install the released versions `tests/crossVersion.test.ts` runs beside this
// build: each one's published tarball, checked against the SHA-256 written in
// tests/crossVersion.baselines.json, into .baselines/<version>.
//
// Usage: node scripts/install-baselines.mjs [directory]
// `npm run test:versions` runs this and then the test.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.baselines')
const baselines = JSON.parse(
  readFileSync('tests/crossVersion.baselines.json', 'utf8'),
)

for (const [version, { sha256 }] of Object.entries(baselines)) {
  const directory = resolve(root, version)
  const entry = resolve(directory, 'node_modules/supergateway/dist/index.js')
  if (existsSync(entry)) {
    console.log(`${version}: already installed`)
    continue
  }
  mkdirSync(directory, { recursive: true })
  const response = await fetch(
    `https://registry.npmjs.org/supergateway/-/supergateway-${version}.tgz`,
    { signal: AbortSignal.timeout(60000) },
  )
  assert.equal(response.status, 200, `${version}: no such published version`)
  const bytes = Buffer.from(await response.arrayBuffer())
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    sha256,
    `${version}: the published tarball is not the one recorded`,
  )
  const tarball = resolve(directory, `supergateway-${version}.tgz`)
  writeFileSync(tarball, bytes)
  execFileSync(
    'npm',
    [
      'install',
      '--prefix',
      directory,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      tarball,
    ],
    { stdio: 'inherit', timeout: 360000, shell: process.platform === 'win32' },
  )
  assert.equal(
    JSON.parse(readFileSync(resolve(entry, '../../package.json'), 'utf8'))
      .version,
    version,
  )
  console.log(`${version}: installed`)
}
