// Real MCP servers through every gateway path, compared with a direct stdio
// connection. Soak-only: it downloads pinned servers from npm and PyPI, so it
// is not part of `npm test`, which stays offline. Run it with
//
//   SUPERGATEWAY_REAL_SERVERS=1 node --import tsx --test scripts/realServers.test.ts
//
// POSIX only: the servers are started through a shell command line.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
// The `ws` client: the SDK's transport needs a global WebSocket, which Node 20
// does not have.
import { WebSocket } from 'ws'
import { launchGateway, unusedPort } from '../tests/helpers/gateway-process.js'
import {
  prepareFixtures,
  realServers,
  type RealServer,
} from './real-servers/servers.js'

globalThis.WebSocket ??= WebSocket as unknown as typeof globalThis.WebSocket

const enabled =
  process.env.SUPERGATEWAY_REAL_SERVERS === '1' && process.platform !== 'win32'
const entry = process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js'
// First use of a pinned server downloads it; later ones start from the cache.
const CALL = { timeout: 120000 }

const shellWord = (word: string) =>
  /^[\w@./:=,-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`

/** Everything a client can observe about a server, then each step's answer. */
async function observe(transport: Transport, server: RealServer) {
  const client = new Client({ name: 'real-server-soak', version: '1.0.0' })
  const settle = async (call: () => Promise<unknown>) => {
    try {
      return { result: await call() }
    } catch (error) {
      const { code, message } = error as { code?: unknown; message?: string }
      return { error: { code, message } }
    }
  }
  try {
    await client.connect(transport, CALL)
    const capabilities = client.getServerCapabilities() ?? {}
    const observed: Record<string, unknown> = {
      server: client.getServerVersion(),
      capabilities,
      instructions: client.getInstructions(),
    }
    if (capabilities.tools)
      observed.tools = await settle(() => client.listTools(undefined, CALL))
    if (capabilities.prompts)
      observed.prompts = await settle(() => client.listPrompts(undefined, CALL))
    if (capabilities.resources) {
      observed.resources = await settle(() =>
        client.listResources(undefined, CALL),
      )
      observed.templates = await settle(() =>
        client.listResourceTemplates(undefined, CALL),
      )
    }
    for (const [label, call] of server.steps)
      observed[label] = await settle(() => call(client))
    const json = JSON.stringify(observed)
    return JSON.parse(server.normalize?.(json) ?? json)
  } finally {
    await client.close().catch(() => {})
  }
}

type Path = {
  name: string
  connect: (
    t: TestContext,
    server: RealServer,
    env: Record<string, string>,
  ) => Promise<Transport>
}

const gatewayFor = async (
  t: TestContext,
  server: RealServer,
  env: Record<string, string>,
  output: string[],
) => {
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      server.argv.map(shellWord).join(' '),
      '--port',
      String(port),
      ...output,
    ],
    env,
  )
  await gateway.ready()
  return `127.0.0.1:${port}`
}

const bridge = (flag: string, url: string, env: Record<string, string>) =>
  new StdioClientTransport({
    command: process.execPath,
    args: [entry, flag, url, '--logLevel', 'none'],
    env: { ...(process.env as Record<string, string>), ...env },
  })

const PATHS: Path[] = [
  {
    name: 'SSE',
    connect: async (t, server, env) => {
      const host = await gatewayFor(t, server, env, [
        '--outputTransport',
        'sse',
      ])
      return new SSEClientTransport(new URL(`http://${host}/sse`))
    },
  },
  {
    name: 'WebSocket',
    connect: async (t, server, env) => {
      const host = await gatewayFor(t, server, env, ['--outputTransport', 'ws'])
      return new WebSocketClientTransport(new URL(`ws://${host}/message`))
    },
  },
  {
    name: 'stateful HTTP',
    connect: async (t, server, env) => {
      const host = await gatewayFor(t, server, env, [
        '--outputTransport',
        'streamableHttp',
        '--stateful',
      ])
      return new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`))
    },
  },
  {
    name: 'stateless HTTP',
    connect: async (t, server, env) => {
      const host = await gatewayFor(t, server, env, [
        '--outputTransport',
        'streamableHttp',
      ])
      return new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`))
    },
  },
  {
    name: 'SSE bridge',
    connect: async (t, server, env) => {
      const host = await gatewayFor(t, server, env, [
        '--outputTransport',
        'sse',
      ])
      return bridge('--sse', `http://${host}/sse`, env)
    },
  },
  {
    name: 'Streamable HTTP bridge',
    connect: async (t, server, env) => {
      const host = await gatewayFor(t, server, env, [
        '--outputTransport',
        'streamableHttp',
        '--stateful',
      ])
      return bridge('--streamableHttp', `http://${host}/mcp`, env)
    },
  },
]

const root = enabled ? mkdtempSync(join(tmpdir(), 'sg-real-')) : ''
const fixtures = enabled ? prepareFixtures(root) : { files: '', repo: '' }

for (const server of realServers(fixtures)) {
  test(
    `${server.name} answers identically through every gateway path`,
    {
      skip: !enabled && 'set SUPERGATEWAY_REAL_SERVERS=1 (POSIX)',
      timeout: 20 * 60000,
    },
    async (t) => {
      let runs = 0
      const envFor = () =>
        server.env?.(mkdtempSync(join(root, `run-${runs++}-`))) ?? {}
      const direct = (env: Record<string, string>) =>
        new StdioClientTransport({
          command: server.argv[0],
          args: server.argv.slice(1),
          env: { ...(process.env as Record<string, string>), ...env },
          stderr: 'ignore',
        })

      // The oracle is only as good as the script: two direct runs must agree
      // before any difference can be blamed on the gateway.
      const expected = await observe(direct(envFor()), server)
      assert.deepEqual(
        await observe(direct(envFor()), server),
        expected,
        `${server.name}: the script is not deterministic without a gateway`,
      )

      for (const path of PATHS) {
        const env = envFor()
        const observed = await observe(
          await path.connect(t, server, env),
          server,
        )
        assert.deepEqual(
          observed,
          expected,
          `${server.name} through ${path.name} differs from a direct connection`,
        )
      }
    },
  )
}
