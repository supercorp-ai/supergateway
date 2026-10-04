// 2026-07-28 requests for a remote server (--streamableHttp, or a `url`
// entry, served over Streamable HTTP), end to end. The remote server is a
// gateway of its own in front of a 2026-07-28 stdio server, so every hop is
// the built CLI.
import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
const options = { timeout: gatewayTimeout(30000) }
const meta = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'remote-modern', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

// A gateway serving a stdio server over Streamable HTTP: the remote server.
const remoteGateway = async (
  t: TestContext,
  peer: string,
  env: Record<string, string> = {},
) => {
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      peer,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ],
    env,
  )
  await gateway.ready()
  return { gateway, url: `http://127.0.0.1:${port}/mcp` }
}

// The gateway under test, in front of `remote`.
const relay = async (
  t: TestContext,
  remote: string,
  args: string[] = [],
  type = '--streamableHttp',
) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    type,
    remote,
    '--outputTransport',
    'streamableHttp',
    '--port',
    String(port),
    ...args,
  ])
  await gateway.ready()
  return { gateway, url: `http://127.0.0.1:${port}/mcp` }
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
  const messages = body.startsWith('event:')
    ? body
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(body)]
  return { status: res.status, message: messages.at(-1), messages }
}

const modernPeer = 'node tests/helpers/modern-bridge-peer.mjs'

for (const stateful of [false, true])
  test(
    `a remote server that speaks 2026-07-28 is sent its clients' requests${stateful ? ' (stateful)' : ''}`,
    options,
    async (t) => {
      const remote = await remoteGateway(t, modernPeer, { MODERN_WIRE: '1' })
      const { gateway, url } = await relay(
        t,
        remote.url,
        stateful ? ['--stateful'] : [],
      )
      // What the remote server answers directly is what its client gets
      // through the relay, but for the server process's own id.
      const same = async (method: string, params = {}, headers = {}) => {
        const [direct, relayed] = await Promise.all([
          post(remote.url, method, params, headers),
          post(url, method, params, headers),
        ])
        const scrub = (value: unknown) =>
          JSON.parse(
            JSON.stringify(value).replace(
              /"version":"\d+"/g,
              '"version":"pid"',
            ),
          )
        assert.deepEqual(scrub(relayed), scrub(direct), method)
        return relayed
      }
      const discovered = await same('server/discover')
      assert.deepEqual(discovered.message.result.supportedVersions, [VERSION])
      const first = await same('tools/list')
      await same('tools/list', { cursor: first.message.result.nextCursor })
      const echoed = await same(
        'tools/call',
        { name: 'echo', arguments: { value: 'hi' } },
        { 'mcp-param-value': 'hi' },
      )
      assert.deepEqual(echoed.message.result.structuredContent, { value: 'hi' })
      await same('prompts/get', { name: 'greet', arguments: { who: 'you' } })
      await same('resources/read', { uri: 'note://alpha' })
      // An event stream: progress, then the remote server's own error.
      const streamed = await same('custom/stream-error')
      assert.deepEqual(
        streamed.messages.map(
          (message) => message.method ?? message.error.code,
        ),
        ['notifications/progress', -32601],
      )
      // Errors keep the status the relay gives them for a local server.
      const missing = await same('nope/method')
      assert.deepEqual(
        [missing.status, missing.message.error.code],
        [404, -32601],
      )
      // The relay checks the mirrors itself, before asking the remote server.
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
      // Asked once what it speaks, not once a request.
      assert.deepEqual(
        (gateway.output() + gateway.errors())
          .split('\n')
          .filter((line) => line.includes('remote server')),
        [`${prefix}The remote server speaks 2026-07-28`],
      )
    },
  )

test(
  "tool names are the client's through the relay, and the remote server's own behind it",
  options,
  async (t) => {
    const remote = await remoteGateway(t, modernPeer, { MODERN_WIRE: '1' })
    const { url } = await relay(t, remote.url, [
      '--toolPrefix',
      'r_',
      '--tools',
      'echo',
    ])
    const first = await post(url, 'tools/list')
    const second = await post(url, 'tools/list', {
      cursor: first.message.result.nextCursor,
    })
    assert.deepEqual(
      [first, second].flatMap(({ message }) =>
        message.result.tools.map((tool: { name: string }) => tool.name),
      ),
      ['r_echo'],
    )
    const echoed = await post(
      url,
      'tools/call',
      { name: 'r_echo', arguments: { value: 'hi' } },
      { 'mcp-param-value': 'hi' },
    )
    assert.deepEqual(echoed.message.result.structuredContent, { value: 'hi' })
    const refused = await post(url, 'tools/call', {
      name: 'r_crash',
      arguments: {},
    })
    assert.deepEqual(refused.message.error, {
      code: -32602,
      message: 'Unknown tool: r_crash',
    })
  },
)

test(
  'a multi-round call reaches the same remote process through the relay',
  options,
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'modern-remote-'))
    t.after(() => rmSync(directory, { recursive: true, force: true }))
    const tracePath = join(directory, 'trace.jsonl')
    const remote = await remoteGateway(
      t,
      'node tests/helpers/signed-continuation-peer.mjs',
      { CONTINUATION_TRACE: tracePath },
    )
    const { url } = await relay(t, remote.url)
    const client = new Client(
      { name: 'remote-modern', version: '1' },
      {
        capabilities: { roots: {} },
        versionNegotiation: {
          mode: { pin: VERSION },
          probe: { timeoutMs: requestTimeout(5000) },
        },
      },
    )
    client.setRequestHandler('roots/list', async () => ({
      roots: [{ uri: 'file:///scratch', name: 'scratch' }],
    }))
    t.after(() => client.close())
    await client.connect(new StreamableHTTPClientTransport(new URL(url)), {
      timeout: requestTimeout(5000),
    })
    const result = await client.callTool(
      { name: 'roots', arguments: { rounds: 2 } },
      { timeout: requestTimeout(10000) },
    )
    const answer = JSON.parse((result.content as { text: string }[])[0].text)
    assert.equal(answer.round, 2)
    // Its state is signed with a key only the process that minted it has.
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
  },
)

// --- A remote server that does not speak it is served as it always was ---

const legacyRemote = async (t: TestContext) => {
  const port = await unusedPort()
  const child = spawn(
    process.execPath,
    [resolve('tests/helpers/remote-mcp-server.mjs')],
    {
      env: { ...process.env, PORT: String(port) },
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  )
  t.after(() => {
    child.kill()
  })
  await once(child.stdout, 'data')
  return `http://127.0.0.1:${port}`
}

test(
  'a remote server that does not speak 2026-07-28: its clients are told so, and fall back',
  options,
  async (t) => {
    const base = await legacyRemote(t)
    for (const [type, path] of [
      ['--streamableHttp', '/mcp'],
      // A remote SSE server has no such requests at all.
      ['--sse', '/sse'],
    ]) {
      const { gateway, url } = await relay(t, `${base}${path}`, [], type)
      // The answer every remote server gave before there was a relay.
      const refused = await post(url, 'server/discover')
      assert.equal(refused.status, 400, type)
      assert.deepEqual(refused.message.id, null, type)
      assert.match(
        refused.message.error.message,
        /^Bad Request: Unsupported protocol version/,
        type,
      )
      // A client that negotiates gets the version the server does speak.
      const client = new Client(
        { name: 'remote-modern', version: '1' },
        {
          versionNegotiation: {
            mode: 'auto',
            probe: { timeoutMs: requestTimeout(5000) },
          },
        },
      )
      t.after(() => client.close())
      await client.connect(new StreamableHTTPClientTransport(new URL(url)), {
        timeout: requestTimeout(5000),
      })
      const result = await client.callTool({
        name: 'add',
        arguments: { a: 2, b: 3 },
      })
      assert.equal((result.content as { text: string }[])[0].text, '5', type)
      const asked = (gateway.output() + gateway.errors())
        .split('\n')
        .filter((line) => line.includes('remote server'))
      assert.deepEqual(
        asked,
        type === '--sse'
          ? []
          : [`${prefix}The remote server does not speak 2026-07-28`],
        type,
      )
    }
  },
)
