import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { knownBugTest } from './helpers/known-bug.js'
import { unusedPort } from './helpers/gateway-process.js'

/**
 * The images in `docker/` are a shipping surface nothing else in this
 * repository looks at.
 *
 * `npm test` exercises the working tree; `docker-publish.yaml` builds these
 * three images and pushes them to two registries without asserting anything
 * about what came out. That gap is not theoretical — it is how
 * `supercorp/supergateway:deno` came to contain no Deno (GW-024 below): the
 * install line is a pipeline, its exit status belongs to the last command in
 * it, and the build reported success while installing nothing.
 *
 * Building three images takes minutes, so this file is opt-in via
 * RUN_DOCKER_TESTS=1 and runs as its own CI job rather than inside `npm test`.
 */
const ENABLED = process.env.RUN_DOCKER_TESTS === '1'
const TAG = 'supergateway-test'

const docker = (args: string[], input?: string) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    input,
    timeout: 600000,
    maxBuffer: 32 * 1024 * 1024,
  })

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

test(
  'docker: the base image runs supergateway as its entrypoint',
  { skip: !ENABLED, timeout: 120000 },
  () => {
    const help = docker(['run', '--rm', `${TAG}:base`])
    assert.match(help, /--stdio/)
    assert.match(help, /--outputTransport/)
  },
)

test(
  'docker: the base image serves a real MCP session',
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
      `${TAG}:base`,
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

    await call({ jsonrpc: '2.0', method: 'notifications/initialized' })
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
  },
)

test(
  'docker: the uvx image can run a uvx-based MCP server',
  { skip: !ENABLED, timeout: 120000 },
  () => {
    for (const binary of ['uv', 'uvx', 'python3']) {
      const found = shell(
        `${TAG}:uvx`,
        `command -v ${binary} || echo MISSING`,
      ).trim()
      assert.notEqual(
        found,
        'MISSING',
        `${binary} is absent from the uvx image`,
      )
    }
  },
)

/**
 * GW-024. `docker/deno.Dockerfile` is two lines:
 *
 *     FROM base
 *     RUN curl -fsSL https://deno.land/install.sh | sh
 *
 * `node:20-alpine` has no `curl`. A shell pipeline exits with the status of its
 * *last* command, so `curl: not found` goes to stderr, `sh` reads an empty
 * stdin and exits 0, and the build succeeds having installed nothing. The
 * published `supercorp/supergateway:deno` is therefore byte-identical in
 * contents to `:base` — verified against the registry image for 3.4.3, not only
 * against a local build.
 *
 * The image exists so users can run a Deno-based MCP server as the `--stdio`
 * command, which is exactly what it cannot do.
 */
knownBugTest(
  'GW-024',
  'docker: the deno image contains deno',
  { timeout: 120000 },
  () => {
    if (!ENABLED) return
    const found = shell(`${TAG}:deno`, 'command -v deno || echo MISSING').trim()
    assert.notEqual(found, 'MISSING', 'the deno image ships without deno')
  },
)
