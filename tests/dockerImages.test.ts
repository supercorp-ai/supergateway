import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { unusedPort } from './helpers/gateway-process.js'

// Opt-in: verify the staged tarball in every shipping container variant.
const ENABLED = process.env.RUN_DOCKER_TESTS === '1'
const PLATFORM =
  process.env.DOCKER_TEST_PLATFORM ??
  `linux/${process.arch === 'arm64' ? 'arm64' : 'amd64'}`
const TAG = `supergateway-test-${PLATFORM.replace('/', '-')}`
const manifest = () =>
  JSON.parse(readFileSync('.release/manifest.json', 'utf8'))

const docker = (args: string[], input?: string) =>
  execFileSync(
    'docker',
    args[0] === 'run'
      ? ['run', '--platform', PLATFORM, ...args.slice(1)]
      : args,
    {
      encoding: 'utf8',
      input,
      timeout: 600000,
      maxBuffer: 32 * 1024 * 1024,
    },
  )

const shell = (image: string, script: string) =>
  docker(['run', '--rm', '--entrypoint', 'sh', image, '-c', script])

before(
  () => {
    if (!ENABLED) return
    // `base` is a build context for the other two, exactly as docker-bake.hcl
    // wires them, so an image built here is the image the registry would get.
    docker([
      'build',
      '-q',
      '--platform',
      PLATFORM,
      '--build-arg',
      `VERSION=${manifest().version}`,
      '--build-arg',
      `PACKAGE_SHA256=${manifest().sha256}`,
      '-f',
      'docker/base.Dockerfile',
      '-t',
      `${TAG}:base`,
      '.',
    ])
    for (const variant of ['uvx', 'deno'])
      docker([
        'build',
        '-q',
        '--platform',
        PLATFORM,
        '-f',
        `docker/${variant}.Dockerfile`,
        '--build-context',
        `base=docker-image://${TAG}:base`,
        '-t',
        `${TAG}:${variant}`,
        '.',
      ])
  },
  { timeout: 1800000 },
)

for (const variant of ['base', 'uvx', 'deno'])
  test(
    `docker: ${variant} runs the exact staged package as its entrypoint`,
    { skip: !ENABLED, timeout: 120000 },
    () => {
      const help = docker(['run', '--rm', `${TAG}:base`])
      assert.match(help, /--stdio/)
      assert.match(help, /--outputTransport/)
    },
  )

for (const variant of ['base', 'uvx', 'deno'])
  test(
    `docker: ${variant} serves a real MCP session`,
    { skip: !ENABLED, timeout: 180000 },
    async (t) => {
      const port = await unusedPort()
      // The repository is mounted only so the container has a peer to spawn; the
      // gateway under test is the globally installed one baked into the image.
      const id = docker([
        'run',
        '-d',
        '-v',
        `${process.cwd()}:/app:ro`,
        '-w',
        '/app',
        '-p',
        `127.0.0.1:${port}:8000`,
        `${TAG}:${variant}`,
        '--stdio',
        'node tests/helpers/mock-mcp-server.js stdio',
        '--port',
        '8000',
        '--outputTransport',
        'streamableHttp',
        '--stateful',
      ]).trim()
      t.after(() => {
        spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
      })

      const url = `http://127.0.0.1:${port}/mcp`
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      }
      const call = (body: unknown) =>
        fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        })

      const deadline = Date.now() + 60000
      let initialized
      for (;;) {
        try {
          initialized = await call({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'docker', version: '1.0.0' },
            },
          })
          if (initialized.ok) break
        } catch {
          // The published port is open before the gateway inside binds to it.
        }
        if (Date.now() > deadline)
          assert.fail(`container never served:\n${docker(['logs', id])}`)
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      const session = initialized.headers.get('mcp-session-id')
      assert.ok(session, 'the image did not issue a session id')
      await initialized.text()
      headers['mcp-session-id'] = session

      const notified = await call({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })
      assert.equal(notified.status, 202)
      await notified.text()
      const listed = await call({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      })
      const body = await listed.text()
      assert.equal(listed.status, 200, body.slice(0, 300))
      assert.match(
        body,
        /"add"/,
        `tools/list from the image: ${body.slice(0, 300)}`,
      )
      const result = await call({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'add', arguments: { a: 17, b: 25 } },
      })
      assert.equal(result.status, 200)
      assert.match(await result.text(), /42/)
      const removed = await fetch(url, {
        method: 'DELETE',
        headers,
        signal: AbortSignal.timeout(10000),
      })
      assert.equal(removed.status, 200)
      await removed.text()
    },
  )

test(
  'docker: the uvx image executes uv, uvx and Python',
  { skip: !ENABLED, timeout: 120000 },
  () => {
    assert.match(shell(`${TAG}:uvx`, 'uv --version'), /uv 0\.12\.15/)
    assert.match(shell(`${TAG}:uvx`, 'uvx --version'), /uvx 0\.12\.15/)
    assert.equal(
      shell(
        `${TAG}:uvx`,
        `uv run --offline --no-project --no-managed-python python3 -c 'print(17 + 25)'`,
      ).trim(),
      '42',
    )
  },
)

test(
  'GW-024: docker deno executes JavaScript',
  { skip: !ENABLED, timeout: 120000 },
  () => {
    assert.match(shell(`${TAG}:deno`, 'deno --version'), /deno 2\.9\.6/)
    assert.equal(
      shell(`${TAG}:deno`, "deno eval 'console.log(17 + 25)'").trim(),
      '42',
    )
  },
)

for (const variant of ['base', 'uvx', 'deno']) {
  test(
    `docker: ${variant} relays modern SDK discovery and tool calls`,
    { skip: !ENABLED, timeout: 120000 },
    async (t) => {
      const port = await unusedPort()
      const id = docker([
        'run',
        '-d',
        '-v',
        `${process.cwd()}:/app:ro`,
        '-w',
        '/app',
        '-p',
        `127.0.0.1:${port}:8000`,
        `${TAG}:${variant}`,
        '--stdio',
        'node tests/helpers/modern-sdk-peer.mjs',
        '--outputTransport',
        'streamableHttp',
      ]).trim()
      t.after(() => {
        spawnSync('docker', ['rm', '-f', id], { stdio: 'ignore' })
      })
      const url = `http://127.0.0.1:${port}/mcp`
      const deadline = Date.now() + 30000
      while (!docker(['logs', id]).includes('Listening on port')) {
        assert.ok(Date.now() < deadline, 'container did not become ready')
        await new Promise((ok) => setTimeout(ok, 100))
      }
      let sequence = 0
      for (const method of ['server/discover', 'tools/list', 'tools/call']) {
        const response = await fetch(url, {
          method: 'POST',
          signal: AbortSignal.timeout(10000),
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': method,
            ...(method === 'tools/call' ? { 'mcp-name': 'probe' } : {}),
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: ++sequence,
            method,
            params: {
              ...(method === 'tools/call'
                ? { name: 'probe', arguments: {} }
                : {}),
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'container-client',
                  version: '1',
                },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('mcp-session-id'), null)
        const reply = await response.json()
        assert.equal(reply.id, sequence)
        if (method === 'server/discover')
          assert.ok(reply.result.supportedVersions.includes('2026-07-28'))
        if (method === 'tools/list')
          assert.equal(reply.result.tools[0].name, 'probe')
        if (method === 'tools/call')
          assert.deepEqual(reply.result.content, [
            { type: 'text', text: 'official SDK stdio result' },
          ])
      }
    },
  )
}

for (const mismatch of ['version', 'digest']) {
  test(
    `docker refuses a candidate with the wrong ${mismatch}`,
    { skip: !ENABLED, timeout: 120000 },
    () => {
      const result = spawnSync(
        'docker',
        [
          'build',
          '--platform',
          PLATFORM,
          '-f',
          'docker/base.Dockerfile',
          '--build-arg',
          `VERSION=${mismatch === 'version' ? '0.0.0-wrong' : manifest().version}`,
          '--build-arg',
          `PACKAGE_SHA256=${mismatch === 'digest' ? '0'.repeat(64) : manifest().sha256}`,
          '.',
        ],
        { encoding: 'utf8', timeout: 110000 },
      )
      assert.notEqual(result.status, 0)
      assert.match(
        result.stderr + result.stdout,
        /did not complete successfully|exit code: 1/,
      )
    },
  )
}
