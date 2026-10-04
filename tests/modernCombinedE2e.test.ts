// 2026-07-28 requests for servers combined on one URL, end to end: the built
// CLI, real 2026-07-28 stdio servers (and one behind another gateway, as a
// remote server), raw requests and the SDK's own client.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

const VERSION = '2026-07-28'
const prefix = '[supergateway] '
const node = process.execPath
const options = { timeout: gatewayTimeout(40000) }
const meta = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientInfo': {
    name: 'combined-modern',
    version: '1',
  },
  'io.modelcontextprotocol/clientCapabilities': { roots: {} },
}

// identity, wait, crash, reverse, echo over two pages; a prompt; a resource
// and a template. With MODERN_WIRE it speaks 2026-07-28.
const paged = {
  command: node,
  args: [resolve('tests/helpers/modern-bridge-peer.mjs')],
  env: { MODERN_WIRE: '1' },
}
// One tool, `roots`, that asks the client for input over several rounds.
const signed = (tracePath: string) => ({
  command: node,
  args: [resolve('tests/helpers/signed-continuation-peer.mjs')],
  env: { CONTINUATION_TRACE: tracePath },
})
// A server of the earlier protocol versions only.
const legacy = {
  command: node,
  args: [resolve('tests/helpers/mock-mcp-server.js'), 'stdio'],
}

const scratch = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-modern-combined-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const serve = async (
  t: TestContext,
  mcpServers: Record<string, unknown>,
  top: Record<string, unknown> = {},
) => {
  const port = await unusedPort()
  const file = join(scratch(t), 'servers.json')
  writeFileSync(
    file,
    JSON.stringify({
      port,
      outputTransport: 'streamableHttp',
      ...top,
      mcpServers,
    }),
  )
  const gateway = launchGateway(t, ['--config', file])
  await gateway.ready()
  return { gateway, base: `http://127.0.0.1:${port}` }
}

const post = async (
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) => {
  const res = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(requestTimeout(8000)),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': VERSION,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...(typeof params.uri === 'string' ? { 'mcp-name': params.uri } : {}),
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
          .filter((line) => line.startsWith('data:'))
          .at(-1)!
          .slice(5),
      )
    : JSON.parse(body)
  return { status: res.status, message }
}

const pinned = async (
  t: TestContext,
  url: string,
  mode: 'auto' | { pin: string },
) => {
  const client = new Client(
    { name: 'combined-modern', version: '1' },
    {
      capabilities: { roots: {} },
      versionNegotiation: { mode, probe: { timeoutMs: requestTimeout(8000) } },
    },
  )
  client.setRequestHandler('roots/list', async () => ({
    roots: [{ uri: 'file:///scratch', name: 'scratch' }],
  }))
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), {
    timeout: requestTimeout(8000),
  })
  return client
}

const logged = (gateway: ReturnType<typeof launchGateway>, pattern: RegExp) =>
  (gateway.output() + gateway.errors())
    .split('\n')
    .filter((line) => pattern.test(line))
    .map((line) => line.replace(prefix, ''))

for (const stateful of [false, true])
  test(
    `servers that all speak 2026-07-28 answer it as one${stateful ? ' (stateful)' : ''}`,
    options,
    async (t) => {
      const tracePath = join(scratch(t), 'trace.jsonl')
      const { gateway, base } = await serve(
        t,
        {
          all: {
            mcpServers: {
              pages: paged,
              signed: { ...signed(tracePath), toolPrefix: 's_' },
            },
          },
        },
        { stateful },
      )
      const url = `${base}/all/mcp`

      const discovered = await post(url, 'server/discover')
      assert.equal(discovered.status, 200)
      const { supportedVersions, serverInfo, instructions, capabilities } =
        discovered.message.result
      assert.deepEqual(supportedVersions, [VERSION])
      assert.deepEqual(
        [serverInfo.name, serverInfo.title],
        ['supergateway', 'all'],
      )
      assert.equal(instructions, '## pages\n\nfixture instructions')
      assert.ok('tools' in capabilities && 'prompts' in capabilities)

      // Every server's tools, every page, as one page.
      const listed = await post(url, 'tools/list')
      assert.deepEqual(
        listed.message.result.tools.map((tool: { name: string }) => tool.name),
        ['identity', 'wait', 'crash', 'reverse', 'echo', 's_roots'],
      )
      assert.equal('nextCursor' in listed.message.result, false)

      // The mirrored header is checked against the schema of the tool's own
      // server, and the call goes to that server only.
      const echoed = await post(
        url,
        'tools/call',
        { name: 'echo', arguments: { value: 'hi' } },
        { 'mcp-param-value': 'hi' },
      )
      assert.deepEqual(echoed.message.result.structuredContent, { value: 'hi' })
      const mismatch = await post(
        url,
        'tools/call',
        { name: 'echo', arguments: { value: 'hi' } },
        { 'mcp-param-value': 'other' },
      )
      assert.deepEqual(
        [mismatch.status, mismatch.message.error.code],
        [400, -32020],
      )
      const unknown = await post(url, 'tools/call', {
        name: 'nope',
        arguments: {},
      })
      assert.deepEqual(unknown.message.error, {
        code: -32602,
        message: 'Unknown tool: nope',
      })
      const read = await post(url, 'resources/read', { uri: 'note://zeta' })
      assert.deepEqual(read.message.result.contents, [
        { uri: 'note://zeta', text: 'alpha-body' },
      ])
      const prompt = await post(url, 'prompts/get', {
        name: 'greet',
        arguments: { who: 'you' },
      })
      assert.equal(prompt.message.result.messages[0].content.text, 'hello you')

      // The SDK's own client, pinned to the version: a call that asks the
      // client for input twice reaches the one process that has its state.
      const client = await pinned(t, url, { pin: VERSION })
      const result = await client.callTool(
        { name: 's_roots', arguments: { rounds: 2 } },
        { timeout: requestTimeout(15000) },
      )
      assert.equal(
        JSON.parse((result.content as { text: string }[])[0].text).round,
        2,
      )
      const minted = readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.event === 'mint')
        .map((entry) => entry.pid)
      assert.equal(
        new Set(minted).size,
        1,
        `one process minted every round: ${minted}`,
      )

      assert.deepEqual(logged(gateway, /speak/), [
        'all: every server speaks 2026-07-28',
      ])
    },
  )

test('a remote server combined is sent what is its own', options, async (t) => {
  // The remote server: another gateway, in front of the paged server.
  const remotePort = await unusedPort()
  const remote = launchGateway(
    t,
    [
      '--stdio',
      'node tests/helpers/modern-bridge-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(remotePort),
    ],
    { MODERN_WIRE: '1' },
  )
  await remote.ready()
  const tracePath = join(scratch(t), 'trace.jsonl')
  const { base } = await serve(t, {
    all: {
      mcpServers: {
        local: signed(tracePath),
        far: {
          url: `http://127.0.0.1:${remotePort}/mcp`,
          type: 'streamableHttp',
          toolPrefix: 'far_',
          tools: ['echo', 'identity'],
        },
      },
    },
  })
  const url = `${base}/all/mcp`
  const listed = await post(url, 'tools/list')
  assert.deepEqual(
    listed.message.result.tools.map((tool: { name: string }) => tool.name),
    ['roots', 'far_identity', 'far_echo'],
  )
  const echoed = await post(
    url,
    'tools/call',
    { name: 'far_echo', arguments: { value: 'over there' } },
    { 'mcp-param-value': 'over there' },
  )
  assert.deepEqual(echoed.message.result.structuredContent, {
    value: 'over there',
  })
  assert.equal(
    (await post(url, 'tools/call', { name: 'far_crash', arguments: {} }))
      .message.error.message,
    'Unknown tool: far_crash',
  )
})

test(
  'with one server that does not speak it, the entry answers as it did, and clients fall back',
  options,
  async (t) => {
    const { gateway, base } = await serve(t, {
      all: { stateful: true, mcpServers: { pages: paged, old: legacy } },
    })
    const url = `${base}/all/mcp`
    // What a stateful entry answers a request it has no session for, as
    // before there was a relay for combined servers: the request went to
    // the sessions of the earlier versions, not to any server.
    const refused = await post(url, 'server/discover')
    assert.deepEqual(
      [refused.status, refused.message.error.message],
      [400, 'Bad Request: No valid session ID provided'],
    )
    // A client that negotiates gets the earlier version, and both servers.
    const client = await pinned(t, url, 'auto')
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    assert.ok(
      tools.includes('add') && tools.includes('identity'),
      tools.join(','),
    )
    const sum = await client.callTool({
      name: 'add',
      arguments: { a: 2, b: 3 },
    })
    assert.equal(
      (sum.content as { text: string }[])[0].text,
      'The sum of 2 and 3 is 5.',
    )
    assert.deepEqual(logged(gateway, /speak/), [
      'all: "old" do not speak 2026-07-28, so the entry answers the earlier versions',
    ])
  },
)

test(
  'a remote SSE server combined has no such requests, so the entry answers the earlier versions',
  options,
  async (t) => {
    const remotePort = await unusedPort()
    const remote = spawn(
      node,
      [resolve('tests/helpers/remote-mcp-server.mjs')],
      {
        env: { ...process.env, PORT: String(remotePort) },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    )
    t.after(() => {
      remote.kill()
    })
    await once(remote.stdout, 'data')
    const { gateway, base } = await serve(t, {
      all: {
        mcpServers: {
          pages: paged,
          events: { url: `http://127.0.0.1:${remotePort}/sse`, type: 'sse' },
        },
      },
    })
    const url = `${base}/all/mcp`
    const refused = await post(url, 'server/discover')
    assert.equal(refused.status, 400)
    assert.match(
      refused.message.error.message,
      /^Bad Request: Unsupported protocol version/,
    )
    const client = await pinned(t, url, 'auto')
    const tools = (await client.listTools()).tools.map((tool) => tool.name)
    assert.ok(
      tools.includes('whoami') && tools.includes('identity'),
      tools.join(','),
    )
    assert.deepEqual(logged(gateway, /speak/), [
      'all: "events" do not speak 2026-07-28, so the entry answers the earlier versions',
    ])
  },
)
