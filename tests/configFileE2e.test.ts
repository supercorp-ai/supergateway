import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Readable } from 'node:stream'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  rpc,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'

// `--config` end to end, against the built CLI: what a file serves and where,
// what it refuses, and the flags around it.

const prefix = '[supergateway] '
const mockServer = resolve('tests/helpers/mock-mcp-server.js')
const envPeer = resolve('tests/helpers/env-peer.mjs')
const node = process.execPath
// The mock server, as a config file runs it: no shell.
const mock = { command: node, args: [mockServer, 'stdio'] }
const options = { timeout: gatewayTimeout(30000) }
const later = 'is coming in a later 4.2 change'

type Gateway = ReturnType<typeof launchGateway>

// A config file in a fresh directory, removed when the test ends.
const writeConfig = (t: TestContext, value: unknown, name = 'servers.json') => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, name)
  writeFileSync(
    path,
    typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  )
  return path
}

const ended = (stream: Readable) =>
  stream.readableEnded ? Promise.resolve() : once(stream, 'end')

// How a gateway expected to stop by itself ended, with everything it wrote;
// `still running` once a generous budget has passed.
const outcome = async (gateway: Gateway) => {
  const exit = await Promise.race([
    gateway.exited,
    delay(requestTimeout(10000), 'still running' as const, { ref: false }),
  ])
  if (exit !== 'still running')
    await Promise.all([
      ended(gateway.child.stdout),
      ended(gateway.child.stderr),
    ])
  return {
    code: exit === 'still running' ? exit : exit.code,
    stdout: gateway.output(),
    stderr: gateway.errors(),
  }
}

const logLines = (text: string) =>
  text
    .split('\n')
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length))

// A gateway serving a config file, once it is ready.
const serve = async (
  t: TestContext,
  config: Record<string, unknown>,
  args: string[] = [],
  env?: Record<string, string>,
) => {
  const port = await unusedPort()
  const file = writeConfig(t, { port, ...config })
  const gateway = launchGateway(t, ['--config', file, ...args], env)
  await gateway.ready()
  return { port, file, gateway }
}

const instructions = (message: { result: { instructions: string } }) =>
  JSON.parse(message.result.instructions)

// --- Printing and checking ---

test(
  '--printConfig without --config prints the command line as a file',
  options,
  async (t) => {
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      '9000',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--header',
      'x-team: core',
      '--oauth2Bearer',
      'secret-token',
      '--apiKey',
      'secret-key',
      '--printConfig',
    ])
    const result = await outcome(gateway)
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.equal(
      result.stdout,
      `${JSON.stringify(
        {
          port: 9000,
          mcpServers: {
            default: {
              stdio: peerCommand,
              path: '/',
              outputTransport: 'streamableHttp',
              headers: { 'x-team': 'core' },
              oauth2Bearer: '<redacted>',
              apiKey: ['<redacted>'],
              stateful: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    )
  },
)

test(
  '--printConfig with --config prints the file as it will run',
  options,
  async (t) => {
    const file = writeConfig(t, {
      port: 8000,
      apiKey: 'file-key',
      mcpServers: {
        tools: { ...mock, env: { API_TOKEN: 't', LEVEL: '2' } },
      },
    })
    const result = await outcome(
      launchGateway(t, ['--config', file, '--port', '9001', '--printConfig']),
    )
    assert.equal(result.code, 0)
    assert.deepEqual(JSON.parse(result.stdout), {
      port: 9001,
      apiKey: ['<redacted>'],
      mcpServers: {
        tools: {
          ...mock,
          env: { API_TOKEN: '<redacted>', LEVEL: '2' },
        },
      },
    })
  },
)

test('--checkConfig reports a valid file and exits 0', options, async (t) => {
  const file = writeConfig(t, {
    mcpServers: {
      tools: mock,
      remote: { url: 'http://127.0.0.1:1/mcp', type: 'http' },
      off: { ...mock, disabled: true },
    },
  })
  const result = await outcome(
    launchGateway(t, ['--config', file, '--checkConfig']),
  )
  assert.deepEqual(result, {
    code: 0,
    stdout: `${file} is valid: 2 servers\n  /tools  tools (sse)\n  /remote  remote (stdio)\n`,
    stderr: '',
  })
  const one = writeConfig(t, {
    mcpServers: { tools: { ...mock, path: '/', outputTransport: 'ws' } },
  })
  assert.equal(
    (await outcome(launchGateway(t, ['--config', one, '--checkConfig'])))
      .stdout,
    `${one} is valid: 1 server\n  /  tools (ws)\n`,
  )
})

test(
  '--checkConfig reports an invalid file where it is wrong, and exits 1',
  options,
  async (t) => {
    const file = writeConfig(
      t,
      '{\n  "mcpServers": {\n    "tools": { "comand": "node" }\n  }\n}\n',
    )
    const result = await outcome(
      launchGateway(t, ['--config', file, '--checkConfig']),
    )
    assert.deepEqual(result, {
      code: 1,
      stdout: '',
      stderr: `${prefix}Error: ${file}:3:16: mcpServers.tools.comand: Unknown key "comand". Did you mean "command"?\n`,
    })
  },
)

test(
  'an invalid file stops the gateway before it starts',
  options,
  async (t) => {
    const file = writeConfig(t, { mcpServers: { tools: { stdio: '' } } })
    const result = await outcome(launchGateway(t, ['--config', file]))
    assert.equal(result.code, 1)
    assert.deepEqual(logLines(result.stderr), [
      `Error: ${file}:4:7: mcpServers.tools.stdio: Expected a non-empty string`,
    ])
    assert.equal(result.stdout, '', 'nothing started')
  },
)

test(
  '--printConfig without a server fails as the command line does',
  options,
  async (t) => {
    for (const [args, error] of [
      [
        [],
        'Error: You must specify one of --stdio, --sse, or --streamableHttp',
      ],
      [
        ['--stdio', peerCommand, '--sse', 'http://127.0.0.1:1/sse'],
        'Error: Specify only one of --stdio, --sse, or --streamableHttp, not multiple',
      ],
    ] as const) {
      const result = await outcome(
        launchGateway(t, [...args, '--port', '9000', '--printConfig']),
      )
      assert.deepEqual(
        result,
        { code: 1, stdout: '', stderr: `${prefix}${error}\n` },
        args.join(' '),
      )
    }
  },
)

test(
  'a file nested too deep to read is an error, not a crash',
  options,
  async (t) => {
    const file = writeConfig(t, `${'['.repeat(200000)}${']'.repeat(200000)}`)
    const result = await outcome(
      launchGateway(t, ['--config', file, '--checkConfig']),
    )
    assert.deepEqual(result, {
      code: 1,
      stdout: '',
      stderr: `${prefix}Error: Maximum call stack size exceeded\n`,
    })
  },
)

test('--checkConfig without --config is an error', options, async (t) => {
  const result = await outcome(
    launchGateway(t, ['--stdio', peerCommand, '--checkConfig']),
  )
  assert.deepEqual(result, {
    code: 1,
    stdout: '',
    stderr: `${prefix}Error: --checkConfig checks the file given with --config\n`,
  })
})

test('a config file that cannot be read is an error', options, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-config-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'missing.json')
  const result = await outcome(launchGateway(t, ['--config', file]))
  assert.deepEqual(result, {
    code: 1,
    stdout: '',
    stderr: `${prefix}Error: Cannot read ${file}: ENOENT: no such file or directory, open '${file}'\n`,
  })
})

// --- Serving one entry ---

test(
  'an entry is served at /<name>: Streamable HTTP at /<name>/mcp',
  options,
  async (t) => {
    const { port, gateway } = await serve(t, {
      mcpServers: { tools: { ...mock, outputTransport: 'streamableHttp' } },
    })
    const { response, messages } = await rpc(
      `http://127.0.0.1:${port}/tools/mcp`,
      initialize(),
    )
    assert.equal(response.status, 200)
    assert.equal(messages[0].result.serverInfo.name, 'mock-server')
    const root = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initialize()),
    })
    assert.equal(root.status, 404, 'nothing is served at /mcp')
    await root.body?.cancel()
    const lines = logLines(gateway.output())
    assert.ok(lines.includes(`  - stdio: ${node} ${mockServer} stdio`))
    assert.ok(lines.includes('  - streamableHttpPath: /tools/mcp'))
  },
)

test(
  'an entry is served at /<name>: SSE at /<name>/sse and /<name>/message',
  options,
  async (t) => {
    const { port, gateway } = await serve(t, { mcpServers: { tools: mock } })
    const client = new Client({ name: 'e2e', version: '1.0.0' })
    t.after(() => client.close())
    await client.connect(
      new SSEClientTransport(new URL(`http://127.0.0.1:${port}/tools/sse`)),
    )
    const { tools } = await client.listTools()
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ['add'],
    )
    const root = await fetch(`http://127.0.0.1:${port}/sse`, {
      signal: AbortSignal.timeout(requestTimeout(5000)),
    })
    assert.equal(root.status, 404, 'nothing is served at /sse')
    await root.body?.cancel()
    await gateway.waitFor(
      () => gateway.output().includes('POST messages:'),
      'announce its message endpoint',
    )
    const lines = logLines(gateway.output())
    assert.ok(
      lines.includes(`SSE endpoint: http://localhost:${port}/tools/sse`),
    )
    assert.ok(
      lines.includes(`POST messages: http://localhost:${port}/tools/message`),
    )
  },
)

test(
  '"path": "/" serves exactly where the command line does',
  options,
  async (t) => {
    const { port } = await serve(t, {
      mcpServers: {
        tools: { ...mock, path: '/', outputTransport: 'streamableHttp' },
      },
    })
    const { response, messages } = await rpc(
      `http://127.0.0.1:${port}/mcp`,
      initialize(),
    )
    assert.equal(response.status, 200)
    assert.equal(messages[0].result.serverInfo.name, 'mock-server')
  },
)

test(
  '"command" and "args" run without a shell, with "env" and "cwd"',
  options,
  async (t) => {
    const cwd = mkdtempSync(join(tmpdir(), 'sg-cwd-'))
    t.after(() => rmSync(cwd, { recursive: true, force: true }))
    const { port } = await serve(
      t,
      {
        mcpServers: {
          peer: {
            command: node,
            args: [envPeer, 'a b', '$HOME', '*', '"quoted"'],
            env: { ENV_PEER_VALUE: 'from-${FROM_GATEWAY}' },
            cwd,
            outputTransport: 'streamableHttp',
          },
        },
      },
      [],
      { FROM_GATEWAY: 'gateway', ENV_PEER_INHERITED: 'inherited' },
    )
    const { messages } = await rpc(
      `http://127.0.0.1:${port}/peer/mcp`,
      initialize(),
    )
    assert.deepEqual(instructions(messages[0]), {
      argv: ['a b', '$HOME', '*', '"quoted"'],
      cwd: realpathSync(cwd),
      value: 'from-gateway',
      inherited: 'inherited',
    })
  },
)

test('"stdio" runs in a shell, with "env" and "cwd"', options, async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sg-cwd-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const { port } = await serve(
    t,
    {
      mcpServers: {
        peer: {
          stdio: `"${node}" "${envPeer}" "$ENV_PEER_VALUE"`,
          env: { ENV_PEER_VALUE: 'set' },
          cwd,
          outputTransport: 'streamableHttp',
        },
      },
    },
    [],
    { ENV_PEER_INHERITED: 'inherited' },
  )
  const { messages } = await rpc(
    `http://127.0.0.1:${port}/peer/mcp`,
    initialize(),
  )
  assert.deepEqual(instructions(messages[0]), {
    argv: ['set'],
    cwd: realpathSync(cwd),
    value: 'set',
    inherited: 'inherited',
  })
})

test('a remote entry is bridged to stdio by default', options, async (t) => {
  const upstreamPort = await unusedPort()
  const upstream = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--outputTransport',
    'streamableHttp',
    '--port',
    String(upstreamPort),
  ])
  await upstream.ready()
  const file = writeConfig(t, {
    mcpServers: {
      remote: {
        url: `http://127.0.0.1:${upstreamPort}/mcp`,
        type: 'streamable-http',
      },
    },
  })
  const gateway = launchGateway(t, ['--config', file])
  await gateway.ready()
  const reply = await stdioRpc(gateway, initialize())
  assert.equal(reply.result.serverInfo.name, 'mock-server')
  assert.ok(
    logLines(gateway.errors()).includes('  - outputTransport: stdio'),
    'announced on stderr, leaving stdout to the protocol',
  )
})

// --- Health and keys ---

test(
  "health endpoints: the gateway's own at the root, an entry's under its path",
  options,
  async (t) => {
    const { port, gateway } = await serve(t, {
      healthEndpoint: '/healthz',
      mcpServers: { tools: { ...mock, healthEndpoint: ['/ready', '/'] } },
    })
    const status = async (path: string) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        signal: AbortSignal.timeout(requestTimeout(5000)),
      })
      return [response.status, await response.text()]
    }
    assert.deepEqual(await status('/healthz'), [200, 'ok'])
    assert.deepEqual(await status('/tools/ready'), [200, 'ok'])
    assert.deepEqual(
      await status('/tools'),
      [200, 'ok'],
      '"/" is the entry path',
    )
    assert.equal((await status('/ready'))[0], 404)
    assert.equal((await status('/tools/healthz'))[0], 404)
    // Express would answer /tools for "/tools/" too; the listing shows which.
    assert.ok(
      logLines(gateway.output()).includes(
        '  - Health endpoints: /healthz, /tools/ready, /tools',
      ),
      gateway.output(),
    )
  },
)

// The status of an initialize at /tools/mcp, with this key if any.
const post = (port: number, key?: string) =>
  fetch(`http://127.0.0.1:${port}/tools/mcp`, {
    method: 'POST',
    signal: AbortSignal.timeout(requestTimeout(5000)),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(initialize()),
  }).then(async (response) => {
    await response.body?.cancel()
    return response.status
  })

test('an "apiKey" in the file locks the entry', options, async (t) => {
  const { port, gateway } = await serve(t, {
    mcpServers: {
      tools: { ...mock, outputTransport: 'streamableHttp', apiKey: 'file-key' },
    },
  })
  assert.equal(await post(port), 401)
  assert.equal(await post(port, 'wrong-key'), 401)
  assert.equal(await post(port, 'file-key'), 200)
  assert.ok(
    logLines(gateway.output()).includes('  - API key: required (1 key)'),
  )
})

test(
  "--apiKey beside --config is accepted in addition to the file's",
  options,
  async (t) => {
    const { port, gateway } = await serve(
      t,
      {
        mcpServers: {
          tools: {
            ...mock,
            outputTransport: 'streamableHttp',
            apiKey: 'file-key',
          },
        },
      },
      ['--apiKey', 'cli-key'],
    )
    assert.equal(await post(port), 401)
    assert.equal(await post(port, 'file-key'), 200)
    assert.equal(await post(port, 'cli-key'), 200)
    assert.ok(
      logLines(gateway.output()).includes('  - API key: required (2 keys)'),
    )
  },
)

test(
  'an empty --apiKey or --apiKeyFile beside --config is refused, never dropped',
  options,
  async (t) => {
    const file = writeConfig(t, {
      port: await unusedPort(),
      mcpServers: { tools: { ...mock, outputTransport: 'streamableHttp' } },
    })
    for (const [flag, label] of [
      [['--apiKey'], '--apiKey'],
      [['--apiKey', ''], '--apiKey'],
      [['--apiKeyFile', ''], '--apiKeyFile'],
    ] as const) {
      const result = await outcome(
        launchGateway(t, ['--config', file, ...flag]),
      )
      assert.equal(result.code, 1, flag.join(' '))
      assert.ok(
        logLines(result.stderr).includes(
          `Error: ${label} is set but empty; give it a value or leave it out`,
        ),
        `${flag.join(' ')}: ${result.stderr}`,
      )
    }
  },
)

// --- Flags beside --config ---

test(
  'a gateway flag beside --config overrides the file, and says so',
  options,
  async (t) => {
    const port = await unusedPort()
    const file = writeConfig(t, {
      port: 1,
      mcpServers: { tools: { ...mock, outputTransport: 'streamableHttp' } },
    })
    const gateway = launchGateway(t, ['--config', file, '--port', String(port)])
    await gateway.ready()
    const lines = logLines(gateway.output())
    assert.deepEqual(lines.slice(0, 2), [
      `--port ${port} overrides "port": 1 from the config file`,
      'Starting...',
    ])
    assert.ok(lines.includes(`Listening on port ${port}`))
  },
)

test(
  'a server or URL flag beside --config is refused, with where it goes',
  options,
  async (t) => {
    const file = writeConfig(t, {
      port: await unusedPort(),
      mcpServers: { tools: mock },
    })
    const server = `Put the server under "mcpServers" in ${file}`
    const setting = (key: string) =>
      `Set "${key}" in ${file}, on a server or at the top level`
    for (const [flags, hint] of [
      [
        ['--stdio', peerCommand],
        `${server}, with "command" and "args", or "stdio"`,
      ],
      [
        ['--sse', 'http://127.0.0.1:1/sse'],
        `${server}, with "url" and "type": "sse"`,
      ],
      [
        ['--streamableHttp', 'http://127.0.0.1:1/mcp'],
        `${server}, with "url" and "type": "streamableHttp"`,
      ],
      [['--header', 'x-team: core'], setting('headers')],
      [['--outputTransport', 'ws'], setting('outputTransport')],
      [['--stateful'], setting('stateful')],
    ] as const) {
      const result = await outcome(
        launchGateway(t, ['--config', file, ...flags]),
      )
      assert.deepEqual(
        result,
        {
          code: 1,
          stdout: '',
          stderr: `${prefix}Error: ${flags[0]} can't be combined with --config. ${hint}\n`,
        },
        flags.join(' '),
      )
    }
  },
)

// --- What this build does not run yet ---

test('a disabled second entry leaves one to run', options, async (t) => {
  const { port } = await serve(t, {
    mcpServers: {
      tools: { ...mock, outputTransport: 'streamableHttp' },
      off: { ...mock, enabled: false },
    },
  })
  const { response } = await rpc(
    `http://127.0.0.1:${port}/tools/mcp`,
    initialize(),
  )
  assert.equal(response.status, 200)
})

test(
  'combined servers on stdio are valid, but not run yet',
  options,
  async (t) => {
    // Only remote servers combined: stdio by default, as one would be.
    const far = { url: 'http://127.0.0.1:1/mcp', type: 'http' }
    const file = writeConfig(t, {
      mcpServers: { all: { mcpServers: { a: far, b: far } } },
    })
    const result = await outcome(launchGateway(t, ['--config', file]))
    assert.deepEqual(result, {
      code: 1,
      stdout: '',
      stderr: `${prefix}Error: Serving combined servers over stdio ${later}; ${file} is valid, but this build can't serve it yet\n`,
    })
  },
)

// --- Other clients' files ---

test(
  'keys only client apps use are warned about, and the server still runs',
  options,
  async (t) => {
    const { port, gateway } = await serve(t, {
      globalShortcut: 'Cmd+K',
      mcpServers: {
        tools: {
          ...mock,
          outputTransport: 'streamableHttp',
          autoApprove: ['add'],
        },
      },
    })
    assert.deepEqual(
      logLines(gateway.errors()).filter((line) => line.startsWith('Warning:')),
      [
        'Warning: Ignored globalShortcut: it is a setting for the client app, not the gateway',
        'Warning: Ignored mcpServers.tools.autoApprove: it is a setting for the client app, not the gateway',
      ],
    )
    const { response } = await rpc(
      `http://127.0.0.1:${port}/tools/mcp`,
      initialize(),
    )
    assert.equal(response.status, 200)
  },
)
