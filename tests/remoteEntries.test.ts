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
  LATEST_PROTOCOL_VERSION,
} from '@modelcontextprotocol/sdk/types.js'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20,
// which the compat job still covers, and the SDK's transport needs one.
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

// Remote servers (`url` entries, and --sse/--streamableHttp) served over HTTP
// and WebSocket, end to end: a real remote server, the built CLI, real clients.

const prefix = '[supergateway] '
const remoteServer = resolve('tests/helpers/remote-mcp-server.mjs')
const options = { timeout: gatewayTimeout(30000) }
globalThis.WebSocket ??= WebSocket as unknown as typeof globalThis.WebSocket

// The remote server, running until the test ends.
const remote = async (t: TestContext) => {
  const port = await unusedPort()
  const child = spawn(process.execPath, [remoteServer], {
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
    child,
    stats: async () =>
      (await (await fetch(`${base}/stats`)).json()) as {
        opened: number
        closed: number
      },
  }
}

const writeConfig = (t: TestContext, value: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-remote-'))
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
  return { base: `http://127.0.0.1:${port}`, port, file, gateway }
}

// A real client, connected; it answers sampling with "pong".
const connect = async (t: TestContext, transport: Transport, name = 'test') => {
  const client = new Client(
    { name, version: '1.0.0' },
    { capabilities: { sampling: {} } },
  )
  client.setRequestHandler(CreateMessageRequestSchema, async () => ({
    model: 'offline-stub',
    role: 'assistant',
    content: { type: 'text', text: 'pong' },
  }))
  t.after(() => client.close())
  await client.connect(transport)
  return client
}

const text = async (client: Client, name: string, args = {}) => {
  const result = await client.callTool({ name, arguments: args })
  return (result.content as { text: string }[])[0].text
}

// Until `check` holds, or a generous budget has passed.
const eventually = async (check: () => Promise<boolean>) => {
  const deadline = Date.now() + requestTimeout(5000)
  while (!(await check()) && Date.now() < deadline) await delay(25)
}

test('a remote server is served over every output', options, async (t) => {
  const up = await remote(t)
  const http = { url: `${up.base}/mcp`, type: 'http' }
  const { base, port } = await serve(t, {
    mcpServers: {
      events: { ...http, outputTransport: 'sse' },
      sockets: { ...http, outputTransport: 'ws' },
      stateless: { ...http, outputTransport: 'streamableHttp' },
      sessions: {
        ...http,
        outputTransport: 'streamableHttp',
        stateful: true,
      },
      fromSse: {
        url: `${up.base}/sse`,
        type: 'sse',
        headers: { 'x-team': 'core' },
        outputTransport: 'streamableHttp',
        stateful: true,
      },
    },
  })
  for (const transport of [
    new SSEClientTransport(new URL(`${base}/events/sse`)),
    new WebSocketClientTransport(
      new URL(`ws://127.0.0.1:${port}/sockets/message`),
    ),
    new StreamableHTTPClientTransport(new URL(`${base}/stateless/mcp`)),
    new StreamableHTTPClientTransport(new URL(`${base}/sessions/mcp`)),
    new StreamableHTTPClientTransport(new URL(`${base}/fromSse/mcp`)),
  ])
    // map: each output reaches the remote server and back
    assert.equal(
      await text(await connect(t, transport), 'add', { a: 2, b: 3 }),
      '5',
    )
})

test(
  "the remote server gets the configured credentials, never the client's",
  options,
  async (t) => {
    const up = await remote(t)
    const entry = {
      url: `${up.base}/mcp`,
      type: 'http',
      headers: { 'x-team': 'core' },
      oauth2Bearer: 'upstream-token',
      apiKey: 'gateway-key',
    }
    const { base, gateway } = await serve(t, {
      mcpServers: {
        events: { ...entry, outputTransport: 'sse' },
        sessions: {
          ...entry,
          outputTransport: 'streamableHttp',
          stateful: true,
        },
      },
    })
    const presented = {
      headers: {
        authorization: 'Bearer gateway-key',
        'x-api-key': 'gateway-key',
      },
    }
    const seen = JSON.stringify({
      authorization: 'Bearer upstream-token',
      'x-api-key': null,
      'x-team': 'core',
    })
    for (const transport of [
      new SSEClientTransport(new URL(`${base}/events/sse`), {
        requestInit: presented,
        eventSourceInit: {
          fetch: (url, init) =>
            fetch(url, {
              ...init,
              headers: { ...presented.headers, accept: 'text/event-stream' },
            }),
        },
      }),
      new StreamableHTTPClientTransport(new URL(`${base}/sessions/mcp`), {
        requestInit: presented,
      }),
    ])
      // map: upstream credentials, and not the client's key
      assert.equal(await text(await connect(t, transport), 'whoami'), seen)

    // map: --header goes upstream, not back to clients
    const response = await fetch(`${base}/events/sse`, {
      headers: presented.headers,
      signal: AbortSignal.timeout(requestTimeout(5000)),
    })
    await response.body?.cancel()
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-team'), null)

    // map: the startup log names the remote server, never its credentials
    const logged = gateway
      .output()
      .split('\n')
      .filter((line) => line.startsWith(`${prefix}[events]`))
    assert.ok(logged.includes(`${prefix}[events]   - Headers: (none)`))
    assert.ok(
      logged.includes(`${prefix}[events]   - streamableHttp: ${up.base}/mcp`),
    )
    assert.ok(
      logged.includes(
        `${prefix}[events]   - Upstream headers: {"x-team":"core","Authorization":"<redacted>"}`,
      ),
    )
    const startup = gateway.output().split(`${prefix}Listening on port`)[0]
    assert.doesNotMatch(startup, /upstream-token/)
  },
)

test('the remote server can ask the client to sample', options, async (t) => {
  const up = await remote(t)
  const http = { url: `${up.base}/mcp`, type: 'http' }
  const { base } = await serve(t, {
    mcpServers: {
      events: { ...http, outputTransport: 'sse' },
      sessions: { ...http, outputTransport: 'streamableHttp', stateful: true },
    },
  })
  for (const transport of [
    new SSEClientTransport(new URL(`${base}/events/sse`)),
    new StreamableHTTPClientTransport(new URL(`${base}/sessions/mcp`)),
  ])
    // map: a request from the server, answered by the client
    assert.equal(
      await text(await connect(t, transport), 'ask'),
      'client said pong',
    )
})

test(
  "a session's end ends its remote session, and shutdown ends them all",
  options,
  async (t) => {
    const up = await remote(t)
    const http = { url: `${up.base}/mcp`, type: 'http' }
    const { base, gateway } = await serve(t, {
      mcpServers: {
        events: { ...http, outputTransport: 'sse' },
        sessions: {
          ...http,
          outputTransport: 'streamableHttp',
          stateful: true,
        },
        stateless: { ...http, outputTransport: 'streamableHttp' },
      },
    })
    const closes = async (expected: number) => {
      await eventually(async () => (await up.stats()).closed === expected)
      return (await up.stats()).closed
    }
    // map: an SSE client leaving
    const events = await connect(
      t,
      new SSEClientTransport(new URL(`${base}/events/sse`)),
    )
    await text(events, 'add', { a: 1, b: 1 })
    await events.close()
    assert.equal(await closes(1), 1)

    // map: a stateful client ending its session
    const ending = new StreamableHTTPClientTransport(
      new URL(`${base}/sessions/mcp`),
    )
    await text(await connect(t, ending), 'add', { a: 1, b: 1 })
    await ending.terminateSession()
    assert.equal(await closes(2), 2)

    // map: a stateless request, and one that only notifies
    const once = new StreamableHTTPClientTransport(
      new URL(`${base}/stateless/mcp`),
    )
    await text(await connect(t, once), 'add', { a: 1, b: 1 })
    await once.send({
      jsonrpc: '2.0',
      method: 'notifications/roots/list_changed',
    })
    await eventually(async () => {
      const { opened, closed } = await up.stats()
      return opened === closed
    })
    const settled = await up.stats()
    assert.equal(settled.closed, settled.opened)

    // map: shutdown, with sessions still open
    await text(
      await connect(t, new SSEClientTransport(new URL(`${base}/events/sse`))),
      'add',
      { a: 1, b: 1 },
    )
    await text(
      await connect(
        t,
        new StreamableHTTPClientTransport(new URL(`${base}/sessions/mcp`)),
      ),
      'add',
      { a: 1, b: 1 },
    )
    const open = await up.stats()
    assert.equal(open.opened - open.closed, 2)
    gateway.child.kill('SIGTERM')
    assert.equal((await gateway.exited).code, 0)
    const after = await up.stats()
    assert.equal(after.closed, after.opened)
  },
)

test(
  'a remote server that refuses or is gone fails the session, not the gateway',
  options,
  async (t) => {
    const up = await remote(t)
    const gone = `http://127.0.0.1:${await unusedPort()}`
    const { base, gateway } = await serve(t, {
      mcpServers: {
        live: { url: `${up.base}/mcp`, type: 'http', outputTransport: 'sse' },
        sessions: {
          url: `${up.base}/mcp`,
          type: 'http',
          outputTransport: 'streamableHttp',
          stateful: true,
        },
        downHttp: {
          url: `${gone}/mcp`,
          type: 'http',
          outputTransport: 'streamableHttp',
          stateful: true,
        },
        downSse: {
          url: `${gone}/sse`,
          type: 'sse',
          outputTransport: 'streamableHttp',
          stateful: true,
        },
      },
    })
    // map: a refused initialize reaches the client as its error
    await assert.rejects(
      connect(
        t,
        new StreamableHTTPClientTransport(new URL(`${base}/sessions/mcp`)),
        'refuse',
      ),
      /refused/,
    )
    // map: a remote server that is not there
    for (const name of ['downHttp', 'downSse'])
      await assert.rejects(
        connect(
          t,
          new StreamableHTTPClientTransport(new URL(`${base}/${name}/mcp`)),
        ),
        name,
      )
    // map: one that goes away mid-session
    const sessions = await connect(
      t,
      new StreamableHTTPClientTransport(new URL(`${base}/sessions/mcp`)),
    )
    up.child.kill()
    await once(up.child, 'exit')
    await assert.rejects(text(sessions, 'add', { a: 1, b: 1 }))
    await eventually(async () =>
      /failed to end the upstream session/.test(gateway.errors()),
    )
    assert.match(
      gateway.errors(),
      /\[sessions\] Session: failed to end the upstream session/,
    )
    // map: the gateway is still serving
    assert.equal(gateway.child.exitCode, null)
    const fresh = await fetch(`${base}/live/sse`, {
      signal: AbortSignal.timeout(requestTimeout(5000)),
    })
    await fresh.body?.cancel()
    assert.equal(fresh.status, 200)
  },
)

test(
  'the command line serves a remote server over HTTP too',
  options,
  async (t) => {
    const up = await remote(t)
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--streamableHttp',
      `${up.base}/mcp`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    // map: the command line form
    assert.equal(
      await text(
        await connect(
          t,
          new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${port}/mcp`),
          ),
        ),
        'add',
        { a: 20, b: 22 },
      ),
      '42',
    )
    assert.match(
      gateway.output(),
      new RegExp(
        `\\n\\[supergateway\\]   - streamableHttp: ${up.base}/mcp\\n\\[supergateway\\]   - Upstream headers: \\(none\\)\\n`,
      ),
    )
  },
)

test(
  'credentials in a remote URL are refused, without printing them',
  options,
  async (t) => {
    const file = writeConfig(t, {
      mcpServers: {
        remote: {
          url: 'http://user:secret@127.0.0.1:1/mcp',
          type: 'http',
          outputTransport: 'sse',
        },
      },
    })
    const gateway = launchGateway(t, ['--config', file])
    // map: refused at startup
    assert.equal((await gateway.exited).code, 1)
    assert.match(
      gateway.errors(),
      /Credentials in the upstream URL are not supported: http:\/\/redacted:redacted@127\.0\.0\.1:1\/mcp/,
    )
    assert.doesNotMatch(gateway.errors() + gateway.output(), /secret/)
  },
)

test(
  "a request the SDK refuses gets the SDK's answer, not a dropped connection",
  options,
  async (t) => {
    const up = await remote(t)
    const { base } = await serve(t, {
      mcpServers: {
        stateless: {
          url: `${up.base}/mcp`,
          type: 'http',
          outputTransport: 'streamableHttp',
        },
      },
    })
    // A 2026-07-28 request is one: the gateway's relay for that revision
    // serves local servers only, so far.
    for (const version of ['2026-07-28', '1999-01-01']) {
      const response = await fetch(`${base}/stateless/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': version,
          'mcp-method': 'tools/list',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        signal: AbortSignal.timeout(requestTimeout(5000)),
      })
      // map: refused, with the SDK's reason
      assert.equal(response.status, 400, version)
      assert.match(
        await response.text(),
        new RegExp(`Unsupported protocol version: ${version}`),
      )
    }
  },
)

test(
  'the command line serves a remote SSE server over WebSocket',
  options,
  async (t) => {
    const up = await remote(t)
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--sse',
      `${up.base}/sse`,
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()
    // map: --sse, alone on the port
    assert.equal(
      await text(
        await connect(
          t,
          new WebSocketClientTransport(
            new URL(`ws://127.0.0.1:${port}/message`),
          ),
        ),
        'add',
        { a: 1, b: 2 },
      ),
      '3',
    )
  },
)

test(
  'a remote session whose client left during initialize is handed to its retry',
  options,
  async (t) => {
    const up = await remote(t)
    const { base, gateway } = await serve(t, {
      mcpServers: {
        events: { url: `${up.base}/mcp`, type: 'http', outputTransport: 'sse' },
      },
    })
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      // Exactly what the retry's client sends: only an identical initialize
      // takes a waiting server over.
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: { sampling: {} },
        clientInfo: { name: 'slow', version: '1.0.0' },
      },
    }
    // A client that sends initialize to a slow server, and gives up.
    const stream = new AbortController()
    const events = await fetch(`${base}/events/sse`, { signal: stream.signal })
    const reader = events.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    const endpoint = /data: (\S+)/.exec(first)![1]
    await fetch(new URL(endpoint, base), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(initialize),
    })
    stream.abort()
    await eventually(async () =>
      /client left before its initialize was answered/.test(gateway.output()),
    )
    // map: kept for a retry, not ended
    assert.match(
      gateway.output(),
      /Session \S+: client left before its initialize was answered/,
    )
    assert.equal((await up.stats()).closed, 0)

    // map: the retry gets the waiting session, and its answer
    const retry = new SSEClientTransport(new URL(`${base}/events/sse`))
    const client = await connect(t, retry, 'slow')
    assert.match(
      gateway.output(),
      /took over a server whose previous client left/,
    )
    assert.equal(await text(client, 'add', { a: 2, b: 2 }), '4')
    assert.equal((await up.stats()).opened, 1)
  },
)
