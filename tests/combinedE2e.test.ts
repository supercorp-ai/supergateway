import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import {
  CreateMessageRequestSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js'
// The `ws` client: Node 20 has no global WebSocket.
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'
import { descendantsOf } from './helpers/process-tree.js'

// Servers combined on one URL (a nested "mcpServers"), end to end: the built
// CLI, real local and remote servers, real clients, over every output.

const prefix = '[supergateway] '
const node = process.execPath
const mockServer = resolve('tests/helpers/mock-mcp-server.js')
// identity, wait, crash, reverse, echo over two pages; a prompt; a resource
// and a template.
const pagedPeer = resolve('tests/helpers/modern-bridge-peer.mjs')
const unhealthyPeer = resolve('tests/helpers/unhealthy-peer.mjs')
const remoteServer = resolve('tests/helpers/remote-mcp-server.mjs')
const mock = { command: node, args: [mockServer, 'stdio'] }
const paged = { command: node, args: [pagedPeer] }
const options = { timeout: gatewayTimeout(30000) }
globalThis.WebSocket ??= WebSocket as unknown as typeof globalThis.WebSocket

type Gateway = ReturnType<typeof launchGateway>

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
  return { url: `http://127.0.0.1:${port}/mcp`, type: 'streamableHttp' }
}

const serve = async (t: TestContext, config: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-combined-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'servers.json')
  const port = await unusedPort()
  writeFileSync(file, JSON.stringify({ port, ...config }, null, 2))
  const gateway = launchGateway(t, ['--config', file])
  await gateway.ready()
  return { gateway, port, base: `http://127.0.0.1:${port}` }
}

const connect = async (t: TestContext, transport: Transport) => {
  const client = new Client(
    { name: 'combined', version: '1.0.0' },
    { capabilities: { sampling: {} } },
  )
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    model: 'offline-stub',
    role: 'assistant',
    content: { type: 'text', text: 'pong' },
  }))
  t.after(() => client.close())
  await client.connect(transport, { timeout: requestTimeout(10000) })
  return client
}

const http = (t: TestContext, base: string, path: string) =>
  connect(t, new StreamableHTTPClientTransport(new URL(`${base}${path}/mcp`)))

const toolNames = async (client: Client) =>
  (await client.listTools()).tools.map((tool) => tool.name)

const text = async (client: Client, name: string, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return (result.content as { text: string }[])[0].text
}

const log = (gateway: Gateway) => gateway.output() + gateway.errors()

const logged = (gateway: Gateway, pattern: RegExp) =>
  log(gateway)
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => line.replace(prefix, ''))

for (const [name, entry, transport] of [
  [
    'sse',
    {},
    (port: number) =>
      new SSEClientTransport(new URL(`http://127.0.0.1:${port}/all/sse`)),
  ],
  [
    'ws',
    { outputTransport: 'ws' },
    (port: number) =>
      new WebSocketClientTransport(
        new URL(`ws://127.0.0.1:${port}/all/message`),
      ),
  ],
  [
    'streamableHttp',
    { outputTransport: 'streamableHttp' },
    (port: number) =>
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/all/mcp`),
      ),
  ],
  [
    'streamableHttp stateful',
    { outputTransport: 'streamableHttp', stateful: true },
    (port: number) =>
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/all/mcp`),
      ),
  ],
] as const)
  test(
    `${name}: local and remote servers answer as one`,
    options,
    async (t) => {
      const far = await remote(t)
      const { gateway, port } = await serve(t, {
        mcpServers: {
          all: { ...entry, mcpServers: { near: mock, pages: paged, far } },
        },
      })
      const client = await connect(t, transport(port))
      assert.deepEqual(client.getServerVersion()?.name, 'supergateway')
      // Every server's tools, every page, in config order; `add` is the first
      // listed server's, the mock's.
      assert.deepEqual(await toolNames(client), [
        'add',
        'identity',
        'wait',
        'crash',
        'reverse',
        'echo',
        'whoami',
        'ask',
      ])
      assert.equal(
        await text(client, 'add', { a: 2, b: 3 }),
        'The sum of 2 and 3 is 5.',
      )
      assert.equal(await text(client, 'echo', { value: 'hi' }), 'hi')
      assert.match(await text(client, 'whoami'), /"authorization":null/)
      // What only one server has goes to it.
      assert.deepEqual(
        (await client.listPrompts()).prompts.map((p) => p.name),
        ['greet'],
      )
      const prompt = await client.getPrompt({
        name: 'greet',
        arguments: { who: 'you' },
      })
      assert.deepEqual(prompt.messages[0].content, {
        type: 'text',
        text: 'hello you',
      })
      const read = await client.readResource({ uri: 'note://beta' })
      assert.deepEqual(read.contents, [
        { uri: 'note://beta', text: 'alpha-body' },
      ])
      assert.deepEqual(logged(gateway, /offered by|combines:/), [
        '  - combines: near, pages, far',
        'all: tool "add" is offered by "near" and "far"; clients get the one of "near", listed first. Set "toolPrefix" on one of them to keep both',
      ])
    },
  )

for (const [name, entry] of [
  ['sse', {}],
  [
    'streamableHttp stateful',
    { outputTransport: 'streamableHttp', stateful: true },
  ],
] as const)
  test(
    `${name}: a combined server's request reaches the client and its answer the server`,
    options,
    async (t) => {
      const far = await remote(t)
      const { port } = await serve(t, {
        mcpServers: { all: { ...entry, mcpServers: { near: mock, far } } },
      })
      const client = await connect(
        t,
        name === 'sse'
          ? new SSEClientTransport(new URL(`http://127.0.0.1:${port}/all/sse`))
          : new StreamableHTTPClientTransport(
              new URL(`http://127.0.0.1:${port}/all/mcp`),
            ),
      )
      // `ask` samples the client and returns what it said.
      assert.equal(await text(client, 'ask'), 'client said pong')
    },
  )

test(
  "prefixes keep clashing tools apart, a server's first and then the entry's",
  options,
  async (t) => {
    const far = await remote(t)
    const { gateway, base } = await serve(t, {
      outputTransport: 'streamableHttp',
      mcpServers: {
        all: {
          toolPrefix: 'x.',
          mcpServers: {
            near: mock,
            far: { ...far, toolPrefix: 'far_', tools: ['add', 'whoami'] },
          },
        },
      },
    })
    const client = await http(t, base, '/all')
    assert.deepEqual(await toolNames(client), [
      'x.add',
      'x.far_add',
      'x.far_whoami',
    ])
    assert.equal(
      await text(client, 'x.add', { a: 1, b: 1 }),
      'The sum of 1 and 1 is 2.',
    )
    assert.equal(await text(client, 'x.far_add', { a: 1, b: 1 }), '2')
    assert.deepEqual(logged(gateway, /offered by/), [])
    assert.deepEqual(logged(gateway, /toolPrefix|tools:/), [
      '  - far: toolPrefix: far_',
      '  - far: tools: add, whoami',
      '  - toolPrefix: x.',
    ])
  },
)

test(
  'a server that cannot start is left out, and the others serve',
  options,
  async (t) => {
    const { gateway, base } = await serve(t, {
      outputTransport: 'streamableHttp',
      stateful: true,
      mcpServers: {
        all: {
          mcpServers: {
            broken: { command: node, args: [unhealthyPeer, 'exit', '3'] },
            refuses: { command: node, args: [unhealthyPeer, 'refuse'] },
            down: {
              url: `http://127.0.0.1:${await unusedPort()}/mcp`,
              type: 'streamableHttp',
            },
            near: mock,
          },
        },
      },
    })
    const client = await http(t, base, '/all')
    assert.deepEqual(await toolNames(client), ['add'])
    assert.equal(
      await text(client, 'add', { a: 4, b: 4 }),
      'The sum of 4 and 4 is 8.',
    )
    const left = logged(gateway, /left out of this session/)
    assert.equal(left.length, 3, left.join('\n'))
    assert.match(
      left.join('\n'),
      /server "broken" is left out of this session: it exited, code=3, signal=null/,
    )
    assert.match(
      left.join('\n'),
      /server "refuses" is left out of this session: database unavailable/,
    )
    assert.match(
      left.join('\n'),
      /server "down" is left out of this session: upstream failure: /,
    )
  },
)

test('when no server starts, the client is told so', options, async (t) => {
  const { base } = await serve(t, {
    outputTransport: 'streamableHttp',
    stateful: true,
    mcpServers: {
      all: {
        mcpServers: {
          a: { command: node, args: [unhealthyPeer, 'exit', '3'] },
          b: { command: node, args: [unhealthyPeer, 'refuse'] },
        },
      },
    },
  })
  const client = new Client({ name: 'combined', version: '1.0.0' })
  await assert.rejects(
    client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/all/mcp`)),
    ),
    /No server of "all" started/,
  )
})

test(
  'a server that stops mid-session fails its call; the rest go on, and the client hears the tools changed',
  options,
  async (t) => {
    const { gateway, port } = await serve(t, {
      mcpServers: { all: { mcpServers: { near: mock, pages: paged } } },
    })
    const client = await connect(
      t,
      new SSEClientTransport(new URL(`http://127.0.0.1:${port}/all/sse`)),
    )
    let changed = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      changed++
    })
    assert.equal((await toolNames(client)).length, 6)
    // "crash" makes its server exit without answering.
    await assert.rejects(
      client.callTool({ name: 'crash', arguments: {} }),
      /MCP server "pages" failed/,
    )
    assert.deepEqual(await toolNames(client), ['add'])
    assert.equal(
      await text(client, 'add', { a: 1, b: 2 }),
      'The sum of 1 and 2 is 3.',
    )
    assert.equal(changed, 1)
    assert.match(
      log(gateway),
      /all: server "pages" stopped: it exited, code=0, signal=null/,
    )
  },
)

test("a session's servers are stopped with it", options, async (t) => {
  const { gateway, port } = await serve(t, {
    mcpServers: { all: { mcpServers: { near: mock, pages: paged } } },
  })
  const running = () =>
    descendantsOf(gateway.child.pid!, { since: gateway.spawnedAt }).length
  const client = await connect(
    t,
    new SSEClientTransport(new URL(`http://127.0.0.1:${port}/all/sse`)),
  )
  await toolNames(client)
  assert.ok(running() >= 2, 'both servers run for the session')
  await client.close()
  const deadline = Date.now() + requestTimeout(5000)
  while (running() > 0 && Date.now() < deadline) await delay(50)
  assert.equal(running(), 0)
})

test('one server combined answers as it does alone', options, async (t) => {
  const { base } = await serve(t, {
    outputTransport: 'streamableHttp',
    stateful: true,
    mcpServers: {
      alone: paged,
      combined: { mcpServers: { only: paged } },
    },
  })
  const alone = await http(t, base, '/alone')
  const combined = await http(t, base, '/combined')
  // Every page of a list, as a client walks it.
  const allTools = async (client: Client) => {
    const tools = []
    let cursor: string | undefined
    do {
      const page = await client.listTools(cursor ? { cursor } : {})
      tools.push(...page.tools)
      cursor = page.nextCursor
    } while (cursor)
    return tools
  }
  assert.deepEqual(await allTools(combined), await allTools(alone))
  for (const ask of [
    (client: Client) => client.listPrompts(),
    (client: Client) => client.listResources(),
    (client: Client) => client.listResourceTemplates(),
    (client: Client) =>
      client.callTool({ name: 'echo', arguments: { value: 'same' } }),
    (client: Client) =>
      client.getPrompt({ name: 'greet', arguments: { who: 'x' } }),
    (client: Client) => client.readResource({ uri: 'note://alpha' }),
    (client: Client) =>
      client.complete({
        ref: { type: 'ref/prompt', name: 'greet' },
        argument: { name: 'who', value: 'al' },
      }),
    (client: Client) => client.getServerCapabilities(),
  ])
    assert.deepEqual(await ask(combined), await ask(alone))
  // Its instructions are under its name, as each server's are.
  assert.equal(
    combined.getInstructions(),
    `## only\n\n${alone.getInstructions()}`,
  )
})

test(
  'the health check of a combined entry starts its servers',
  options,
  async (t) => {
    const { base } = await serve(t, {
      outputTransport: 'streamableHttp',
      healthCheck: 'server',
      mcpServers: {
        good: {
          healthEndpoint: '/healthz',
          mcpServers: { near: mock, pages: paged },
        },
        bad: {
          healthEndpoint: '/healthz',
          mcpServers: {
            a: { command: node, args: [unhealthyPeer, 'exit', '3'] },
          },
        },
      },
    })
    const health = async (path: string) => {
      const response = await fetch(`${base}${path}`)
      return [response.status, await response.text()]
    }
    assert.deepEqual(await health('/good/healthz'), [200, 'ok'])
    assert.deepEqual(await health('/bad/healthz'), [
      503,
      'unhealthy: the server refused: No server of "bad" started',
    ])
  },
)
