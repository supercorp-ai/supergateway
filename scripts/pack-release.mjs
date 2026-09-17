// Pack local code for tests, or download an exact published version for images.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function packRelease(publishedVersion) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const output = resolve(root, '.release')
  mkdirSync(output, { recursive: true })
  const npm =
    process.env.npm_execpath ??
    resolve(
      dirname(process.execPath),
      process.platform === 'win32'
        ? 'node_modules/npm/bin/npm-cli.js'
        : '../lib/node_modules/npm/bin/npm-cli.js',
    )
  if (publishedVersion)
    assert.match(publishedVersion, /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/)
  const [packed] = JSON.parse(
    execFileSync(
      process.execPath,
      [
        npm,
        'pack',
        ...(publishedVersion
          ? [`supergateway@${publishedVersion}`, '--prefer-online']
          : []),
        '--json',
        '--pack-destination',
        output,
      ],
      {
        cwd: root,
        encoding: 'utf8',
        ...(publishedVersion ? { timeout: 60000 } : {}),
      },
    ),
  )
  if (publishedVersion) assert.equal(packed.version, publishedVersion)
  for (const file of packed.files)
    assert.match(file.path, /^(dist\/|package\.json$|README\.md$|LICENSE$)/)
  assert.ok(
    !packed.files.some((f) => /(?:shrinkwrap|lock)\.json$/.test(f.path)),
  )
  const bytes = readFileSync(resolve(output, packed.filename))
  const manifest = {
    version: packed.version,
    filename: packed.filename,
    integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    publishedVersion: publishedVersion ?? null,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    sourceDirty: Boolean(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
    ),
    files: packed.files,
  }
  copyFileSync(
    resolve(output, packed.filename),
    resolve(output, 'supergateway.tgz'),
  )
  writeFileSync(
    resolve(output, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  )
  return manifest
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(JSON.stringify(packRelease(process.argv[2]), null, 2))
