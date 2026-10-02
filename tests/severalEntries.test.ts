import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

// Several config entries served on one port, end to end against the built CLI.

const prefix = '[supergateway] '
const node = process.execPath
const mockServer = resolve('tests/helpers/mock-mcp-server.js')
const identityPeer = resolve('tests/helpers/lifecycle-identity-peer.mjs')
const mock = { command: node, args: [mockServer, 'stdio'] }
const options = { timeout: gatewayTimeout(30000) }

const writeConfig = (t: TestContext, value: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-several-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'servers.json')
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

const serve = async (
  t: TestContext,
  config: Record<string, unknown>,
  args: string[] = [],
) => {
  const port = await unusedPort()
  const file = writeConfig(t, { port, ...config })
  const gateway = launchGateway(t, ['--config', file, ...args])
  await gateway.ready()
  return { port, file, gateway }
}

// Connects a real client, and returns what the server says about itself and
// its tools.
const connect = async (t: TestContext, transport: Transport) => {
  const client = new Client({ name: 'several', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(transport)
  const { tools } = await client.listTools()
  return {
    tools: tools.map((tool) => tool.name),
    version: client.getServerVersion()!.version,
  }
}

const status = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(requestTimeout(5000)),
  })
  await response.body?.cancel()
  return response.status
}

const initializeBody = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'several', version: '1.0.0' },
  },
})
const post = (url: string, headers: Record<string, string> = {}) =>
  status(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: initializeBody,
  })

test(
  'every output transport serves its own entry on one port',
  options,
  async (t) => {
    const { port, gateway } = await serve(t, {
      mcpServers: {
        events: mock,
        stateless: { ...mock, outputTransport: 'streamableHttp' },
        sockets: { ...mock, outputTransport: 'ws' },
        sessions: {
          ...mock,
          outputTransport: 'streamableHttp',
          stateful: true,
          path: '/team/sessions',
        },
      },
    })
    const base = `http://127.0.0.1:${port}`
    // map: each entry answers a real client at its own URL
    for (const transport of [
      new SSEClientTransport(new URL(`${base}/events/sse`)),
      new StreamableHTTPClientTransport(new URL(`${base}/stateless/mcp`)),
      new WebSocketClientTransport(
        new URL(`ws://127.0.0.1:${port}/sockets/message`),
      ),
      new StreamableHTTPClientTransport(new URL(`${base}/team/sessions/mcp`)),
    ])
      assert.deepEqual((await connect(t, transport)).tools, ['add'])

    // map: the startup log names the entry each line is about
    const command = `${node} ${mockServer} stdio`
    const logged = gateway
      .output()
      .split('\n')
      .filter((line) => line.startsWith(prefix))
      .map((line) => line.slice(prefix.length))
    assert.deepEqual(
      logged.slice(
        0,
        logged.findIndex((line) =>
          line.startsWith('[sessions] StreamableHttp'),
        ) + 1,
      ),
      [
        'Starting...',
        'Supergateway is supported by Supercov - Coverage for coding agents and software factories 🌙 - https://supercov.com',
        `  - port: ${port}`,
        '  - Health endpoints: (none)',
        '[events]   - path: /events',
        '[events]   - outputTransport: sse',
        '[events]   - Headers: (none)',
        `[events]   - stdio: ${command}`,
        '[events]   - ssePath: /events/sse',
        '[events]   - messagePath: /events/message',
        '[events]   - CORS: disabled',
        '[events]   - Health endpoints: (none)',
        '[stateless]   - path: /stateless',
        '[stateless]   - outputTransport: streamableHttp',
        '[stateless] Running stateless server',
        '[stateless]   - Headers: (none)',
        `[stateless]   - stdio: ${command}`,
        '[stateless]   - streamableHttpPath: /stateless/mcp',
        '[stateless]   - protocolVersion: 2024-11-05',
        '[stateless]   - CORS: disabled',
        '[stateless]   - Health endpoints: (none)',
        '[sockets]   - path: /sockets',
        '[sockets]   - outputTransport: ws',
        `[sockets]   - stdio: ${command}`,
        '[sockets]   - messagePath: /sockets/message',
        '[sockets]   - CORS: disabled',
        '[sockets]   - Health endpoints: (none)',
        '[sessions]   - path: /team/sessions',
        '[sessions]   - outputTransport: streamableHttp',
        '[sessions] Running stateful server',
        '[sessions]   - Headers: (none)',
        `[sessions]   - stdio: ${command}`,
        '[sessions]   - streamableHttpPath: /team/sessions/mcp',
        '[sessions]   - CORS: disabled',
        '[sessions]   - Health endpoints: (none)',
        '[sessions]   - Session timeout: 1800000ms',
        `Listening on port ${port}`,
        `[events] SSE endpoint: http://localhost:${port}/events/sse`,
        `[events] POST messages: http://localhost:${port}/events/message`,
        `[stateless] StreamableHttp endpoint: http://localhost:${port}/stateless/mcp`,
        `[sockets] WebSocket endpoint: ws://localhost:${port}/sockets/message`,
        `[sessions] StreamableHttp endpoint: http://localhost:${port}/team/sessions/mcp`,
      ],
    )
  },
)

test(
  'the gateway answers its health endpoint; a path no entry holds gets 404',
  options,
  async (t) => {
    const { port } = await serve(t, {
      healthEndpoint: '/healthz',
      mcpServers: {
        a: { ...mock, outputTransport: 'streamableHttp', healthEndpoint: '/' },
        b: { ...mock, outputTransport: 'streamableHttp' },
      },
    })
    const base = `http://127.0.0.1:${port}`
    // map: gateway health
    assert.equal(await status(`${base}/healthz`), 200)
    // map: an entry's own health endpoint, under its path
    assert.equal(await status(`${base}/a`), 200)
    // map: entries' URLs
    assert.equal(await post(`${base}/a/mcp`), 200)
    assert.equal(await post(`${base}/b/mcp`), 200)
    // map: no entry holds the path
    assert.equal(await status(`${base}/c/mcp`), 404)
    // map: an entry's path that it doesn't route
    assert.equal(await status(`${base}/b/healthz`), 404)
  },
)

test(
  "an entry's key locks only that entry; a key beside --config locks them all",
  options,
  async (t) => {
    const config = {
      mcpServers: {
        locked: { ...mock, outputTransport: 'streamableHttp', apiKey: 'own' },
        open: { ...mock, outputTransport: 'streamableHttp' },
      },
    }
    const bearer = (key: string) => ({ authorization: `Bearer ${key}` })
    {
      const { port, gateway } = await serve(t, config)
      const base = `http://127.0.0.1:${port}`
      // map: the entry's own key
      assert.equal(await post(`${base}/locked/mcp`), 401)
      assert.equal(await post(`${base}/locked/mcp`, bearer('own')), 200)
      // map: the other entry stays open
      assert.equal(await post(`${base}/open/mcp`), 200)
      assert.match(gateway.output(), /\[locked\] {3}- API key: required/)
      await gateway.dispose()
    }
    {
      const { port } = await serve(t, config, ['--apiKey', 'deploy'])
      const base = `http://127.0.0.1:${port}`
      // map: the deploy key on every entry, beside the entry's own
      assert.equal(await post(`${base}/open/mcp`), 401)
      assert.equal(await post(`${base}/open/mcp`, bearer('deploy')), 200)
      assert.equal(await post(`${base}/locked/mcp`, bearer('deploy')), 200)
      assert.equal(await post(`${base}/locked/mcp`, bearer('own')), 200)
      assert.equal(await post(`${base}/open/mcp`, bearer('own')), 401)
    }
  },
)

test(
  'WebSocket entries share the port; an upgrade for no WebSocket path is refused',
  options,
  async (t) => {
    const { port } = await serve(t, {
      outputTransport: 'ws',
      mcpServers: {
        left: mock,
        right: mock,
        page: { ...mock, outputTransport: 'sse' },
      },
    })
    // map: each WebSocket entry upgrades its own path
    for (const name of ['left', 'right'])
      assert.deepEqual(
        (
          await connect(
            t,
            new WebSocketClientTransport(
              new URL(`ws://127.0.0.1:${port}/${name}/message`),
            ),
          )
        ).tools,
        ['add'],
      )
    // map: an upgrade elsewhere gets 400, as from a WebSocket server alone
    for (const path of ['/page/sse', '/nowhere'])
      assert.equal(
        await new Promise((resolve, reject) => {
          const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
          socket.on('unexpected-response', (_req, res) => {
            resolve(res.statusCode)
            socket.terminate()
          })
          socket.on('open', () => reject(new Error(`${path} upgraded`)))
          socket.on('error', () => {})
        }),
        400,
        path,
      )
  },
)

test(
  'a URL another entry or the health endpoint would receive is refused',
  options,
  async (t) => {
    const cases: [Record<string, unknown>, string][] = [
      [
        {
          mcpServers: {
            root: { ...mock, path: '/' },
            sse: { ...mock, outputTransport: 'streamableHttp' },
          },
        },
        '"root" serves /sse, but "sse" at /sse would receive it. Give one of them a different "path"',
      ],
      [
        {
          healthEndpoint: '/a/mcp',
          mcpServers: {
            a: { ...mock, outputTransport: 'streamableHttp' },
            b: mock,
          },
        },
        '"a" serves /a/mcp, which is also the gateway\'s health endpoint',
      ],
    ]
    for (const [config, conflict] of cases)
      for (const extra of [[], ['--checkConfig']]) {
        const file = writeConfig(t, config)
        const gateway = launchGateway(t, ['--config', file, ...extra])
        const exit = await Promise.race([
          gateway.exited,
          delay(
            requestTimeout(10000),
            { code: 'still running' },
            { ref: false },
          ),
        ])
        // map: refused, the check included
        assert.equal(exit.code, 1)
        assert.equal(gateway.output(), '')
        assert.equal(gateway.errors(), `${prefix}Error: ${file}: ${conflict}\n`)
      }
  },
)

test('JSON logs name the entry each line is about', options, async (t) => {
  const { gateway } = await serve(
    t,
    { mcpServers: { a: mock, b: { ...mock, outputTransport: 'ws' } } },
    ['--logFormat', 'json'],
  )
  const lines = gateway
    .output()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  const about = (msg: string) =>
    lines.filter((line) => line.msg === msg).map(({ server }) => server ?? null)
  // map: the gateway's own lines have no server, each entry's name it
  assert.deepEqual(about('Starting...'), [null])
  assert.deepEqual(about('  - path: /a'), ['a'])
  assert.deepEqual(about('  - messagePath: /b/message'), ['b'])
  assert.deepEqual(
    lines.filter((line) => /endpoint:/.test(line.msg)).map((l) => l.server),
    ['a', 'b'],
  )
})

test("shutdown stops every entry's children", options, async (t) => {
  const peer = { command: node, args: [identityPeer] }
  const { port, gateway } = await serve(t, {
    mcpServers: {
      events: peer,
      sessions: { ...peer, outputTransport: 'streamableHttp', stateful: true },
    },
  })
  const pids = [
    await connect(
      t,
      new SSEClientTransport(new URL(`http://127.0.0.1:${port}/events/sse`)),
    ),
    await connect(
      t,
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/sessions/mcp`),
      ),
    ),
  ].map(({ version }) => Number(version))
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  assert.deepEqual(pids.map(alive), [true, true])
  gateway.child.kill('SIGTERM')
  const { code } = await gateway.exited
  // map: clean exit, every entry's child gone
  assert.equal(code, 0)
  for (let i = 0; i < 100 && pids.some(alive); i++) await delay(20)
  assert.deepEqual(pids.map(alive), [false, false])
})
