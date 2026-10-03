import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocketClientTransport } from '@modelcontextprotocol/sdk/client/websocket.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
// The `ws` client: Node 20 has no global WebSocket.
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

// --toolPrefix and --tools, end to end: the built CLI, real servers and real
// clients, over every output, the bridges and the 2026-07-28 relay.

const prefix = '[supergateway] '
const node = process.execPath
// Five tools over two pages: identity, wait | crash, reverse, echo.
const pagedPeer = resolve('tests/helpers/modern-bridge-peer.mjs')
const remoteServer = resolve('tests/helpers/remote-mcp-server.mjs')
const options = { timeout: gatewayTimeout(30000) }
globalThis.WebSocket ??= WebSocket as unknown as typeof globalThis.WebSocket

const connect = async (t: TestContext, transport: Transport) => {
  const client = new Client({ name: 'tool-names', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(transport, { timeout: requestTimeout(10000) })
  return client
}

// Every page of the client's tool list.
const toolList = async (client: Client) => {
  const names: string[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor ? { cursor } : {})
    names.push(...page.tools.map((tool) => tool.name))
    cursor = page.nextCursor
  } while (cursor)
  return names
}

const text = async (client: Client, name: string, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return (result.content as { text: string }[])[0].text
}

// The error a call gets, as a client sees it.
const refusal = async (client: Client, name: string) => {
  const error = await client
    .callTool({ name, arguments: {} })
    .then(() => assert.fail(`${name} was called`))
    .catch((error: { code: number; message: string }) => error)
  return [error.code, error.message]
}

const unknownTool = (name: string) => [
  -32602,
  `MCP error -32602: Unknown tool: ${name}`,
]

const listingLines = (output: string) =>
  output
    .split('\n')
    .filter((line) => /toolPrefix|  - tools:/.test(line))
    .map((line) => line.replace(prefix, ''))

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
  return `http://127.0.0.1:${port}`
}

const outputs: [string, string[], (port: number) => Transport][] = [
  [
    'sse',
    [],
    (port) => new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)),
  ],
  [
    'ws',
    ['--outputTransport', 'ws'],
    (port) =>
      new WebSocketClientTransport(new URL(`ws://127.0.0.1:${port}/message`)),
  ],
  [
    'streamableHttp',
    ['--outputTransport', 'streamableHttp'],
    (port) =>
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
  ],
  [
    'streamableHttp --stateful',
    ['--outputTransport', 'streamableHttp', '--stateful'],
    (port) =>
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
  ],
]

for (const [name, output, transport] of outputs)
  test(
    `${name}: a client sees the allowed tools under the prefix`,
    options,
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        `"${node}" "${pagedPeer}"`,
        ...output,
        '--port',
        String(port),
        '--toolPrefix',
        'gh_',
        '--tools',
        'identity',
        'echo',
      ])
      await gateway.ready()
      assert.deepEqual(listingLines(gateway.output()), [
        '  - toolPrefix: gh_',
        '  - tools: identity, echo',
      ])
      const client = await connect(t, transport(port))
      // Filtered page by page, the cursor kept.
      assert.deepEqual(await toolList(client), ['gh_identity', 'gh_echo'])
      assert.equal(await text(client, 'gh_echo', { value: 'hi' }), 'hi')
      // Its own name, and a tool left out: neither reaches the server, which
      // would have exited on "crash".
      assert.deepEqual(await refusal(client, 'echo'), unknownTool('echo'))
      assert.deepEqual(
        await refusal(client, 'gh_crash'),
        unknownTool('gh_crash'),
      )
      assert.match(await text(client, 'gh_identity'), /"count":1/)
    },
  )

test(
  'a remote server bridged to stdio: prefixed and filtered both ways',
  options,
  async (t) => {
    const base = await remote(t)
    for (const [flag, url] of [
      ['--streamableHttp', `${base}/mcp`],
      ['--sse', `${base}/sse`],
    ]) {
      const client = await connect(
        t,
        new StdioClientTransport({
          command: node,
          args: [
            'dist/index.js',
            flag,
            url,
            '--toolPrefix',
            'far.',
            '--tools',
            'add',
            '--tools',
            'whoami',
          ],
          stderr: 'ignore',
        }),
      )
      assert.deepEqual(await toolList(client), ['far.add', 'far.whoami'], flag)
      assert.equal(await text(client, 'far.add', { a: 2, b: 3 }), '5')
      assert.deepEqual(await refusal(client, 'far.ask'), unknownTool('far.ask'))
      assert.deepEqual(await refusal(client, 'add'), unknownTool('add'))
    }
  },
)

test('each bridge lists its tool settings at start', options, async (t) => {
  const base = await remote(t)
  for (const [flag, url] of [
    ['--streamableHttp', `${base}/mcp`],
    ['--sse', `${base}/sse`],
  ]) {
    const gateway = launchGateway(t, [
      flag,
      url,
      '--toolPrefix',
      'far_',
      '--tools',
    ])
    await gateway.ready()
    assert.deepEqual(
      listingLines(gateway.errors()),
      ['  - toolPrefix: far_', '  - tools: (none)'],
      flag,
    )
  }
})

const writeConfig = (t: TestContext, value: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-tools-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'servers.json')
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

test(
  'config entries: a top-level prefix for all, a filter per entry',
  options,
  async (t) => {
    const base = await remote(t)
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--config',
      writeConfig(t, {
        port,
        outputTransport: 'streamableHttp',
        toolPrefix: 'sg_',
        mcpServers: {
          far: {
            url: `${base}/mcp`,
            type: 'streamableHttp',
            tools: ['whoami'],
          },
          near: { command: node, args: [pagedPeer], toolPrefix: 'near_' },
        },
      }),
    ])
    await gateway.ready()
    const far = await connect(
      t,
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/far/mcp`),
      ),
    )
    assert.deepEqual(await toolList(far), ['sg_whoami'])
    assert.deepEqual(await refusal(far, 'sg_add'), unknownTool('sg_add'))
    const near = await connect(
      t,
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/near/mcp`),
      ),
    )
    assert.deepEqual(await toolList(near), [
      'near_identity',
      'near_wait',
      'near_crash',
      'near_reverse',
      'near_echo',
    ])
  },
)

test(
  'a prefix a tool name cannot carry is warned about',
  options,
  async (t) => {
    const gateway = launchGateway(t, [
      '--stdio',
      `"${node}" "${pagedPeer}"`,
      '--port',
      String(await unusedPort()),
      '--toolPrefix',
      'git hub/',
    ])
    await gateway.ready()
    assert.match(
      gateway.output() + gateway.errors(),
      /toolPrefix "git hub\/" makes tool names a client may refuse/,
    )
  },
)

// --- The 2026-07-28 relay ---

const VERSION = '2026-07-28'
const meta = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'tool-names', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

const post = async (
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(requestTimeout(5000)),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': VERSION,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method,
      params: { _meta: meta, ...params },
    }),
  })
  const body = await res.text()
  const message = body.startsWith('event:')
    ? JSON.parse(
        body
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5),
      )
    : JSON.parse(body)
  return { status: res.status, message }
}

for (const stateful of [false, true])
  test(
    `2026-07-28 relay${stateful ? ' (stateful)' : ''}: the same tools, and a refused call never reaches a server`,
    options,
    async (t) => {
      const dir = mkdtempSync(join(tmpdir(), 'sg-tools-modern-'))
      t.after(() => rmSync(dir, { recursive: true, force: true }))
      const tracePath = join(dir, 'trace.jsonl')
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        [
          '--stdio',
          `"${node}" "${pagedPeer}"`,
          '--outputTransport',
          'streamableHttp',
          ...(stateful ? ['--stateful'] : []),
          '--port',
          String(port),
          '--toolPrefix',
          'gh_',
          '--tools',
          'echo',
          'wait',
        ],
        { MODERN_TRACE: tracePath, MODERN_WIRE: '1' },
      )
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      const calls = () =>
        readFileSync(tracePath, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
          .filter((entry) => entry.message?.method === 'tools/call')
          .map((entry) => entry.message.params.name)

      const first = await post(url, 'tools/list')
      assert.equal(first.status, 200)
      assert.deepEqual(
        first.message.result.tools.map((tool: { name: string }) => tool.name),
        ['gh_wait'],
      )
      const second = await post(url, 'tools/list', {
        cursor: first.message.result.nextCursor,
      })
      assert.deepEqual(
        second.message.result.tools.map((tool: { name: string }) => tool.name),
        ['gh_echo'],
      )

      // The header the schema asks for is checked against the server's own
      // schema, found under the server's own name.
      const echoed = await post(
        url,
        'tools/call',
        { name: 'gh_echo', arguments: { value: 'hi' } },
        { 'mcp-param-value': 'hi' },
      )
      assert.deepEqual(
        [echoed.status, echoed.message.result.structuredContent],
        [200, { value: 'hi' }],
      )
      assert.deepEqual(calls(), ['echo'])

      for (const name of ['echo', 'gh_crash']) {
        const refused = await post(url, 'tools/call', { name, arguments: {} })
        assert.deepEqual(
          [refused.status, refused.message],
          [
            200,
            {
              jsonrpc: '2.0',
              id: 17,
              error: { code: -32602, message: `Unknown tool: ${name}` },
            },
          ],
        )
      }
      assert.deepEqual(calls(), ['echo'], 'no refused call reached a server')
    },
  )
