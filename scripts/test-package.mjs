import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath
const runtimeNpm =
  process.env.SUPERGATEWAY_TEST_NPM ??
  resolve(
    dirname(runtime),
    process.platform === 'win32'
      ? 'node_modules/npm/bin/npm-cli.js'
      : '../lib/node_modules/npm/bin/npm-cli.js',
  )
const buildNpm =
  process.env.npm_execpath ??
  resolve(
    dirname(process.execPath),
    process.platform === 'win32'
      ? 'node_modules/npm/bin/npm-cli.js'
      : '../lib/node_modules/npm/bin/npm-cli.js',
  )
const temporary = mkdtempSync(join(tmpdir(), 'supergateway-package-'))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const runtimeEnv = {
  ...process.env,
  PATH:
    dirname(runtime) +
    (process.platform === 'win32' ? ';' : ':') +
    process.env.PATH,
}
async function run(executable, args, cwd, env, capture = false) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const timer = setTimeout(() => child.kill(), 240000)
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (!capture) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      process.stderr.write(chunk)
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`${executable} exited with ${code ?? signal}`))
    })
  })
}
let server
try {
  const packed = JSON.parse(
    await run(
      process.execPath,
      [buildNpm, 'pack', '--json', '--pack-destination', temporary],
      root,
      process.env,
      true,
    ),
  )[0]
  for (const file of packed.files)
    assert.match(
      file.path,
      /^(dist\/|package\.json$|npm-shrinkwrap\.json$|README\.md$|LICENSE$)/,
    )
  assert.ok(packed.files.some((file) => file.path === 'npm-shrinkwrap.json'))
  const tarball = readFileSync(join(temporary, packed.filename))
  let registry
  // Exercise registry installation: older npm handles a local tarball's
  // shrinkwrap differently from the registry's _hasShrinkwrap manifest.
  server = createServer((req, res) => {
    if (req.url === '/supergateway/-/candidate.tgz') {
      res.end(tarball)
      return
    }
    if (req.url === '/supergateway') {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          name: pkg.name,
          'dist-tags': { latest: pkg.version },
          versions: {
            [pkg.version]: {
              ...pkg,
              _hasShrinkwrap: true,
              dist: {
                tarball: registry + '/supergateway/-/candidate.tgz',
                integrity:
                  'sha512-' +
                  createHash('sha512').update(tarball).digest('base64'),
              },
            },
          },
        }),
      )
      return
    }
    res.writeHead(302, { location: 'https://registry.npmjs.org' + req.url })
    res.end()
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  registry = `http://127.0.0.1:${server.address().port}`
  const cache = join(temporary, 'cache')
  const output = await run(
    runtime,
    [
      runtimeNpm,
      'exec',
      '--yes',
      '--engine-strict',
      '--no-audit',
      '--no-fund',
      '--cache',
      cache,
      '--registry',
      registry,
      '--package',
      `${pkg.name}@${pkg.version}`,
      '--',
      'supergateway',
      '--help',
    ],
    temporary,
    runtimeEnv,
    true,
  )
  assert.match(output, /--outputTransport/)
  const entry = readdirSync(join(cache, '_npx'))
    .map((name) =>
      join(cache, '_npx', name, 'node_modules/supergateway/dist/index.js'),
    )
    .find(existsSync)
  assert.ok(entry, 'npx installed the candidate CLI')
  const installed = JSON.parse(
    readFileSync(resolve(entry, '../../package.json'), 'utf8'),
  )
  assert.equal(installed.version, pkg.version)
  assert.equal(installed.engines.node, pkg.engines.node)
  await run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      'tests/modernProtocol.test.ts',
      'tests/modernHttpSafety.test.ts',
      'tests/protocolVersionMatrix.test.ts',
    ],
    root,
    {
      ...runtimeEnv,
      SUPERGATEWAY_TEST_NODE: runtime,
      SUPERGATEWAY_TEST_ENTRY: entry,
    },
  )
  console.log(`Verified packed ${pkg.name}@${pkg.version} with ${runtime}`)
} finally {
  if (server) {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
  rmSync(temporary, { recursive: true, force: true })
}
