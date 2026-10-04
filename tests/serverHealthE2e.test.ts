import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'
import { descendantsOf } from './helpers/process-tree.js'

// --healthCheck server (#83), end to end: the built CLI, real servers, and
// the health endpoints asked over HTTP.

const prefix = '[supergateway] '
const node = process.execPath
const mockServer = resolve('tests/helpers/mock-mcp-server.js')
const unhealthyPeer = resolve('tests/helpers/unhealthy-peer.mjs')
const remoteServer = resolve('tests/helpers/remote-mcp-server.mjs')
// As a config file runs them: no shell.
const healthy = { command: node, args: [mockServer, 'stdio'] }
const exiting = { command: node, args: [unhealthyPeer, 'exit', '3'] }
const refusing = { command: node, args: [unhealthyPeer, 'refuse'] }
// As --stdio runs them, through the shell.
const healthyCommand = `"${node}" "${mockServer}" stdio`
const exitingCommand = `"${node}" "${unhealthyPeer}" exit 3`
const options = { timeout: gatewayTimeout(30000) }

type Gateway = ReturnType<typeof launchGateway>

// A server that exits at once shows as its exit, or, when the gateway's
// first write to it fails before the exit is seen, as that write failing.
// Which comes first is the operating system's to decide; the tests take the
// second as the first.
const asExit = (text: string) =>
  text.replace(
    'the server failed: write EPIPE',
    'the server exited (code=3, signal=null)',
  )

const health = async (url: string, headers?: Record<string, string>) => {
  const response = await fetch(url, { headers })
  return {
    status: response.status,
    body: asExit(await response.text()),
    response,
  }
}

const healthLine = (gateway: Gateway) =>
  (gateway.output() + gateway.errors())
    .split('\n')
    .filter((line) => line.includes('Health endpoints:'))

// The gateway's descendants, until there are none or a generous budget
// has passed.
const settledDescendants = async (gateway: Gateway) => {
  const deadline = Date.now() + requestTimeout(5000)
  for (;;) {
    const left = descendantsOf(gateway.child.pid!, {
      since: gateway.spawnedAt,
    })
    if (left.length === 0 || Date.now() > deadline) return left
    await delay(50)
  }
}

const listen = async (t: TestContext, args: string[]) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, ['--port', String(port), ...args])
  await gateway.ready()
  return { base: `http://127.0.0.1:${port}`, gateway }
}

const writeConfig = (t: TestContext, value: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-health-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'servers.json')
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

const serveConfig = async (t: TestContext, config: Record<string, unknown>) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--config',
    writeConfig(t, { port, ...config }),
  ])
  await gateway.ready()
  return { base: `http://127.0.0.1:${port}`, gateway }
}

const ended = (stream: Readable) =>
  stream.readableEnded ? Promise.resolve() : once(stream, 'end')

// How a gateway expected to refuse its arguments ended.
const refusal = async (gateway: Gateway) => {
  const exit = await Promise.race([
    gateway.exited,
    delay(requestTimeout(10000), 'still running' as const, { ref: false }),
  ])
  assert.notEqual(exit, 'still running')
  await Promise.all([ended(gateway.child.stdout), ended(gateway.child.stderr)])
  return {
    code: (exit as { code: number | null }).code,
    stderr: gateway.errors(),
  }
}

const remote = async (t: TestContext) => {
  const port = await unusedPort()
  const child = spawn(node, [remoteServer], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => {
    child.kill()
  })
  await once(child.stdout, 'data')
  const base = `http://127.0.0.1:${port}`
  return {
    base,
    stats: async () =>
      (await (await fetch(`${base}/stats`)).json()) as {
        opened: number
        closed: number
      },
  }
}

for (const output of [
  ['--outputTransport', 'sse'],
  ['--outputTransport', 'ws'],
  ['--outputTransport', 'streamableHttp'],
  ['--outputTransport', 'streamableHttp', '--stateful'],
])
  test(
    `${output.slice(1).join(' ')}: a server that answers is healthy, and the one started to check is stopped`,
    options,
    async (t) => {
      const { base, gateway } = await listen(t, [
        '--stdio',
        healthyCommand,
        ...output,
        '--healthEndpoint',
        '/healthz',
        '--healthEndpoint',
        '/readyz',
        '--healthCheck',
        'server',
      ])
      assert.deepEqual(healthLine(gateway), [
        `${prefix}  - Health endpoints: /healthz, /readyz (checks the MCP server)`,
      ])
      const first = await health(`${base}/healthz`)
      assert.deepEqual([first.status, first.body], [200, 'ok'])
      // Nothing is left of the server the check started.
      assert.deepEqual(await settledDescendants(gateway), [])
      const second = await health(`${base}/readyz`)
      assert.deepEqual([second.status, second.body], [200, 'ok'])
      assert.doesNotMatch(gateway.output() + gateway.errors(), /unhealthy/)
    },
  )

test(
  'a server that exits is unhealthy: 503 with why, logged once',
  options,
  async (t) => {
    const { base, gateway } = await listen(t, [
      '--stdio',
      exitingCommand,
      '--outputTransport',
      'streamableHttp',
      '--healthEndpoint',
      '/healthz',
      '--healthCheck',
      'server',
    ])
    for (let i = 0; i < 3; i++) {
      const { status, body } = await health(`${base}/healthz`)
      assert.deepEqual(
        [status, body],
        [503, 'unhealthy: the server exited (code=3, signal=null)'],
      )
    }
    const logged = asExit(gateway.output() + gateway.errors())
      .split('\n')
      .filter((line) => line.includes('Health check:'))
    assert.deepEqual(logged, [
      `${prefix}Health check: the server is unhealthy: the server exited (code=3, signal=null)`,
    ])
  },
)

test(
  'SSE puts --header on the health endpoint, healthy or not',
  options,
  async (t) => {
    for (const command of [healthyCommand, exitingCommand]) {
      const { base } = await listen(t, [
        '--stdio',
        command,
        '--healthEndpoint',
        '/healthz',
        '--healthCheck',
        'server',
        '--header',
        'X-Deployment: blue',
      ])
      const { response } = await health(`${base}/healthz`)
      assert.equal(response.headers.get('x-deployment'), 'blue')
    }
  },
)

test(
  'by default, the health endpoints check the gateway alone',
  options,
  async (t) => {
    // A server that cannot start is not started for the check, so the gateway
    // still answers ok, as it always has.
    const { base, gateway } = await listen(t, [
      '--stdio',
      exitingCommand,
      '--outputTransport',
      'streamableHttp',
      '--healthEndpoint',
      '/healthz',
    ])
    assert.deepEqual(healthLine(gateway), [
      `${prefix}  - Health endpoints: /healthz`,
    ])
    const { status, body } = await health(`${base}/healthz`)
    assert.deepEqual([status, body], [200, 'ok'])
    assert.doesNotMatch(
      gateway.output() + gateway.errors(),
      /Health check|exited/,
    )
  },
)

test(
  'without health endpoints, --healthCheck server lists none',
  options,
  async (t) => {
    const { gateway } = await listen(t, [
      '--stdio',
      healthyCommand,
      '--outputTransport',
      'ws',
      '--healthCheck',
      'server',
    ])
    assert.deepEqual(healthLine(gateway), [
      `${prefix}  - Health endpoints: (none)`,
    ])
  },
)

test(
  'a remote server is checked over a session of its own, which is ended',
  options,
  async (t) => {
    const up = await remote(t)
    const { base } = await listen(t, [
      '--streamableHttp',
      `${up.base}/mcp`,
      '--outputTransport',
      'streamableHttp',
      '--healthEndpoint',
      '/healthz',
      '--healthCheck',
      'server',
    ])
    const { status, body } = await health(`${base}/healthz`)
    assert.deepEqual([status, body], [200, 'ok'])
    const deadline = Date.now() + requestTimeout(5000)
    let stats = await up.stats()
    while (stats.closed < stats.opened && Date.now() < deadline) {
      await delay(25)
      stats = await up.stats()
    }
    assert.deepEqual(stats, { ...stats, opened: 1, closed: 1 })
  },
)

test(
  'a remote server that is down is unhealthy, with the cause',
  options,
  async (t) => {
    // A port nothing listens on: the probe's connection is refused. fetch
    // says only "fetch failed"; the refusal is its cause.
    const closed = await unusedPort()
    // The SDK and Node versions word the rest differently.
    for (const [input, url, output, reason] of [
      [
        '--streamableHttp',
        `http://127.0.0.1:${closed}/mcp`,
        'sse',
        /^unhealthy: the server failed: fetch failed \(.*ECONNREFUSED.*\)$/,
      ],
      [
        '--sse',
        `http://127.0.0.1:${closed}/sse`,
        'ws',
        /^unhealthy: the server failed: .*ECONNREFUSED/,
      ],
    ] as const) {
      const { base, gateway } = await listen(t, [
        input,
        url,
        '--outputTransport',
        output,
        '--healthEndpoint',
        '/healthz',
        '--healthCheck',
        'server',
      ])
      const { status, body } = await health(`${base}/healthz`)
      assert.equal(status, 503)
      assert.match(body, reason)
      // The reason is logged; the transport's own trace is not.
      assert.doesNotMatch(
        gateway.output() + gateway.errors(),
        /upstream error|\n\s+at /,
      )
    }
  },
)

test(
  'config entries each check their own server; the gateway-wide endpoint checks the gateway',
  options,
  async (t) => {
    const up = await remote(t)
    const { base, gateway } = await serveConfig(t, {
      healthCheck: 'server',
      healthEndpoint: '/healthz',
      outputTransport: 'streamableHttp',
      mcpServers: {
        good: { ...healthy, healthEndpoint: '/healthz' },
        gone: { ...exiting, healthEndpoint: '/healthz' },
        broken: { ...refusing, healthEndpoint: '/healthz' },
        // The top-level default, set back for one entry.
        plain: {
          ...exiting,
          healthCheck: 'gateway',
          healthEndpoint: '/healthz',
        },
        far: {
          url: `${up.base}/mcp`,
          type: 'streamableHttp',
          healthEndpoint: '/healthz',
        },
      },
    })
    const answers: Record<string, [number, string]> = {}
    for (const path of [
      '/healthz',
      '/good/healthz',
      '/gone/healthz',
      '/broken/healthz',
      '/plain/healthz',
      '/far/healthz',
    ]) {
      const { status, body } = await health(`${base}${path}`)
      answers[path] = [status, body]
    }
    assert.deepEqual(answers, {
      '/healthz': [200, 'ok'],
      '/good/healthz': [200, 'ok'],
      '/gone/healthz': [
        503,
        'unhealthy: the server exited (code=3, signal=null)',
      ],
      '/broken/healthz': [
        503,
        'unhealthy: the server refused: database unavailable',
      ],
      '/plain/healthz': [200, 'ok'],
      '/far/healthz': [200, 'ok'],
    })
    const lines = healthLine(gateway)
    assert.deepEqual(lines, [
      `${prefix}  - Health endpoints: /healthz`,
      `${prefix}[good]   - Health endpoints: /good/healthz (checks the MCP server)`,
      `${prefix}[gone]   - Health endpoints: /gone/healthz (checks the MCP server)`,
      `${prefix}[broken]   - Health endpoints: /broken/healthz (checks the MCP server)`,
      `${prefix}[plain]   - Health endpoints: /plain/healthz`,
      `${prefix}[far]   - Health endpoints: /far/healthz (checks the MCP server)`,
    ])
  },
)

test(
  '--healthCheck beside --config belongs in the file',
  options,
  async (t) => {
    const file = writeConfig(t, { mcpServers: { good: healthy } })
    assert.deepEqual(
      await refusal(
        launchGateway(t, ['--config', file, '--healthCheck', 'server']),
      ),
      {
        code: 1,
        stderr: `${prefix}Error: --healthCheck can't be combined with --config. Set "healthCheck" in ${file}, on a server or at the top level\n`,
      },
    )
  },
)

test(
  'a healthCheck other than gateway or server is refused',
  options,
  async (t) => {
    const file = writeConfig(t, {
      mcpServers: { good: { ...healthy, healthCheck: 'deep' } },
    })
    const fromFile = await refusal(launchGateway(t, ['--config', file]))
    assert.equal(fromFile.code, 1)
    assert.match(
      fromFile.stderr,
      /mcpServers\.good\.healthCheck: Expected one of "gateway", "server"/,
    )

    const fromCli = await refusal(
      launchGateway(t, ['--stdio', healthyCommand, '--healthCheck', 'deep']),
    )
    assert.equal(fromCli.code, 1)
    assert.match(
      fromCli.stderr,
      /Invalid values:\s+Argument: healthCheck, Given: "deep", Choices: "gateway", "server"/,
    )
  },
)
