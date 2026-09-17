import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createServer as createPortProbe } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  realpathSync,
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
const installTimeoutMs = 6 * 60 * 1000
async function run(
  executable,
  args,
  cwd,
  env,
  capture = false,
  timeoutMs = 240000,
) {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let errors = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      output += chunk
      if (!capture) process.stdout.write(chunk)
    })
    child.stderr.on('data', (chunk) => {
      errors += chunk
      process.stderr.write(chunk)
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      if (!timedOut && code === 0) resolve(output)
      else
        reject(
          new Error(
            `${executable} ${args.join(' ')} ${timedOut ? `timed out after ${timeoutMs / 1000}s` : `exited with ${code ?? signal}`}\n${output}\n${errors}`,
          ),
        )
    })
  })
}
let server
try {
  const staged = process.env.SUPERGATEWAY_PACKAGE_MANIFEST
  const packed = staged
    ? JSON.parse(readFileSync(staged, 'utf8'))
    : JSON.parse(
        await run(
          process.execPath,
          [buildNpm, 'pack', '--json', '--pack-destination', temporary],
          root,
          process.env,
          true,
        ),
      )[0]
  for (const file of packed.files)
    assert.match(file.path, /^(dist\/|package\.json$|README\.md$|LICENSE$)/)
  assert.ok(
    !packed.files.some((file) => /(?:shrinkwrap|lock)\.json$/.test(file.path)),
  )
  assert.equal(packed.version, pkg.version)
  console.log(
    `Testing ${packed.files.length} files from ${staged ?? 'fresh pack'}`,
  )
  const tarball = readFileSync(
    join(staged ? dirname(resolve(staged)) : temporary, packed.filename),
  )
  const integrity =
    'sha512-' + createHash('sha512').update(tarball).digest('base64')
  assert.equal(integrity, packed.integrity)
  const oldResponse = await fetch(
    'https://registry.npmjs.org/supergateway/3.4.3',
  )
  assert.equal(oldResponse.status, 200)
  const oldPackage = await oldResponse.json()
  let latest = '3.4.3'
  let registry
  // Exercise the real registry/npx path with normal dependency resolution.
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
          'dist-tags': { latest, next: pkg.version },
          versions: {
            '3.4.3': oldPackage,
            [pkg.version]: {
              ...pkg,
              _hasShrinkwrap: false,
              dist: {
                tarball: registry + '/supergateway/-/candidate.tgz',
                integrity: integrity,
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
  console.log(`Installing candidate with ${runtime} and ${runtimeNpm}`)
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
    installTimeoutMs,
  )
  assert.match(output, /--outputTransport/)
  console.log('Fresh npx install and CLI help succeeded')
  const entry = readdirSync(join(cache, '_npx'))
    .map((name) =>
      join(cache, '_npx', name, 'node_modules/supergateway/dist/index.js'),
    )
    .find(existsSync)
  assert.ok(entry, 'npx installed the candidate CLI')
  const installedRoot = resolve(entry, '../..')
  for (const name of [
    'typescript',
    'ts-node',
    'lint-staged',
    'husky',
    'fast-check',
    'prev-modelcontextprotocol-sdk',
  ]) {
    assert.equal(
      existsSync(join(installedRoot, 'node_modules', name)),
      false,
      `Published package installed development dependency ${name}`,
    )
    assert.equal(
      existsSync(resolve(installedRoot, '..', name)),
      false,
      `npx installed hoisted development dependency ${name}`,
    )
  }
  console.log('Fresh npx installation excludes development tools and test SDKs')
  const npx = resolve(dirname(runtimeNpm), 'npx-cli.js')
  const project = join(temporary, 'existing project with spaces')
  mkdirSync(project)
  const projectBytes =
    JSON.stringify({ name: 'existing-client', private: true }) + '\n'
  writeFileSync(join(project, 'package.json'), projectBytes)
  writeFileSync(join(project, '.npmrc'), 'fund=false\n')
  const warmCache = join(temporary, 'warm-cache')
  const npxRun = (spec, selectedCache = warmCache) =>
    run(
      runtime,
      [
        npx,
        '--yes',
        '--engine-strict',
        '--no-audit',
        '--no-fund',
        '--cache',
        selectedCache,
        '--registry',
        registry,
        spec,
        '--version',
      ],
      project,
      runtimeEnv,
      true,
      installTimeoutMs,
    )
  latest = '3.4.3'
  // Published 3.4.3 prints `unknown` outside its repository; identify it by metadata.
  assert.equal((await npxRun('supergateway')).trim(), 'unknown')
  const cachedVersions = readdirSync(join(warmCache, '_npx')).map((name) => {
    const path = join(
      warmCache,
      '_npx',
      name,
      'node_modules/supergateway/package.json',
    )
    return existsSync(path)
      ? JSON.parse(readFileSync(path, 'utf8')).version
      : null
  })
  assert.ok(
    cachedVersions.includes('3.4.3'),
    'warm cache actually contains the released package',
  )
  assert.equal((await npxRun('supergateway@next')).trim(), pkg.version)
  assert.equal((await npxRun('supergateway@latest')).trim(), 'unknown')
  assert.equal((await npxRun('supergateway')).trim(), 'unknown')
  console.log(
    'Next selects the candidate; latest and bare npx still select released 3.4.3',
  )
  latest = pkg.version
  const implicit = (await npxRun('supergateway')).trim()
  assert.ok([pkg.version, 'unknown'].includes(implicit))
  console.log(
    `Warm bare npx selected ${implicit === 'unknown' ? 'cached 3.4.3 (npm cache reuse)' : pkg.version}`,
  )
  assert.equal((await npxRun('supergateway@latest')).trim(), pkg.version)
  assert.equal(
    (await npxRun(`supergateway@${pkg.version}`)).trim(),
    pkg.version,
  )
  assert.equal(
    (await npxRun('supergateway', join(temporary, 'bare-fresh-cache'))).trim(),
    pkg.version,
  )
  assert.equal(
    readFileSync(join(project, 'package.json'), 'utf8'),
    projectBytes,
  )
  assert.equal(readFileSync(join(project, '.npmrc'), 'utf8'), 'fund=false\n')
  assert.equal(existsSync(join(project, 'package-lock.json')), false)
  assert.equal(existsSync(join(project, 'node_modules')), false)
  // A typical client launcher supplies argv and a working directory. Exercise
  // that exact shape, including a quoted subprocess filename containing spaces.
  writeFileSync(
    join(project, 'server file.mjs'),
    `
import readline from 'node:readline';
for await (const line of readline.createInterface({input: process.stdin})) {
  const r = JSON.parse(line); if (r.id === undefined) continue;
  const result = r.method === 'initialize'
    ? {protocolVersion: '2024-11-05', capabilities: {tools: {}}, serverInfo: {name: 'cwd-peer', version: '1'}}
    : {content: [{type: 'text', text: process.cwd()}]};
  process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: r.id, result}) + '\\n');
}
`,
  )
  const probe = createPortProbe()
  await new Promise((ok) => probe.listen(0, ok))
  const port = probe.address().port
  await new Promise((ok) => probe.close(ok))
  const launch = spawn(
    runtime,
    [
      npx,
      '--yes',
      '--engine-strict',
      '--no-audit',
      '--no-fund',
      '--cache',
      cache,
      '--registry',
      registry,
      `supergateway@${pkg.version}`,
      '--stdio',
      `"${runtime}" "server file.mjs"`,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ],
    {
      cwd: project,
      env: runtimeEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  )
  let diagnostics = ''
  launch.stdout.on('data', (c) => (diagnostics += c))
  launch.stderr.on('data', (c) => (diagnostics += c))
  const exited = new Promise((ok, reject) => {
    launch.once('error', reject)
    launch.once('exit', ok)
  })
  try {
    const deadline = Date.now() + 30000
    while (!diagnostics.includes('Listening on port')) {
      assert.ok(Date.now() < deadline && launch.exitCode === null, diagnostics)
      await delay(50)
    }
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    }
    const request = (body) =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      })
    const initialized = await request({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'launcher', version: '1' },
      },
    })
    assert.equal(initialized.status, 200)
    headers['mcp-session-id'] = initialized.headers.get('mcp-session-id')
    assert.ok(headers['mcp-session-id'])
    await initialized.text()
    const response = await request({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'cwd', arguments: {} },
    })
    assert.equal(response.status, 200)
    const wire = await response.text()
    const message = JSON.parse(
      wire
        .split('\n')
        .find((line) => line.startsWith('data:'))
        .slice(5),
    )
    assert.equal(
      realpathSync(message.result.content[0].text),
      realpathSync(project),
    )
    const closed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(10000),
    })
    assert.equal(closed.status, 200)
    await closed.text()
    launch.stdin.end()
    assert.equal(
      await Promise.race([exited, delay(10000).then(() => 'timeout')]),
      0,
      diagnostics,
    )
  } finally {
    launch.stdin.end()
    if (launch.exitCode === null) launch.kill()
  }
  console.log(
    'Actual npx launcher preserves working directory, quoted command and session cleanup',
  )
  console.log(
    'Actual npx: fresh and explicit latest with 3.4.3-warm cache select the candidate; existing project unchanged',
  )

  const installed = JSON.parse(
    readFileSync(resolve(entry, '../../package.json'), 'utf8'),
  )
  assert.equal(installed.version, pkg.version)
  assert.equal(installed.engines.node, pkg.engines.node)
  if (process.env.SUPERGATEWAY_INSTALLED_ENTRY_FILE)
    writeFileSync(process.env.SUPERGATEWAY_INSTALLED_ENTRY_FILE, entry + '\n')
  await run(
    process.execPath,
    [
      '--import',
      'tsx',
      '--test',
      '--test-concurrency=1',
      'tests/modernProtocol.test.ts',
      'tests/modernTransparency.test.ts',
      'tests/modernAutoCompatibility.test.ts',
      'tests/modernHttpSafety.test.ts',
      'tests/modernRelayEdges.test.ts',
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
  if (process.env.SUPERGATEWAY_KEEP_PACKAGE === '1')
    console.log(`Retained package installation: ${temporary}`)
  else rmSync(temporary, { recursive: true, force: true })
}
