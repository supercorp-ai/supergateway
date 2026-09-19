import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const version = process.env.SOAK_PACKAGE_VERSION
const digest = process.env.SOAK_PACKAGE_SHA256
assert.equal(version, '4.0.0-rc.3', 'Select the RC.3 candidate explicitly')
assert.match(
  digest ?? '',
  /^[a-f0-9]{64}$/,
  'Supply the verified published SHA-256',
)
const root = resolve('.release/public-soak')
mkdirSync(root, { recursive: true })
const response = await fetch(
  `https://registry.npmjs.org/supergateway/-/supergateway-${version}.tgz`,
  { signal: AbortSignal.timeout(60000) },
)
assert.equal(response.status, 200)
const bytes = Buffer.from(await response.arrayBuffer())
assert.equal(createHash('sha256').update(bytes).digest('hex'), digest)
const tarball = resolve(root, `supergateway-${version}.tgz`)
writeFileSync(tarball, bytes)
const npmCli = process.env.npm_execpath
assert.ok(npmCli, 'Run with npm exec -- node scripts/install-soak-artifact.mjs')
execFileSync(
  process.execPath,
  [
    npmCli,
    'install',
    '--prefix',
    root,
    '--no-audit',
    '--no-fund',
    '--ignore-scripts',
    tarball,
  ],
  { stdio: 'inherit', timeout: 360000 },
)
const entry = resolve(root, 'node_modules/supergateway/dist/index.js')
assert.equal(
  JSON.parse(readFileSync(resolve(entry, '../../package.json'), 'utf8'))
    .version,
  version,
)
writeFileSync(resolve(root, 'entry.txt'), entry + '\n')
writeFileSync(
  resolve(root, 'artifact.json'),
  JSON.stringify({ version, sha256: digest, entry }, null, 2) + '\n',
)
if (process.env.GITHUB_ENV)
  appendFileSync(process.env.GITHUB_ENV, `SUPERGATEWAY_TEST_ENTRY=${entry}\n`)
console.log(`Verified published artifact: ${entry}`)
