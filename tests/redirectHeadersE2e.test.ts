import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  requestTimeout,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * A remote server that redirects, end to end, for every way the gateway
 * reaches one: the bridges (--streamableHttp and --sse to stdio), `url`
 * entries served over HTTP, and the 2026-07-28 relay.
 *
 * Another origin gets the request without the configured headers; the same
 * origin still gets them, and either way the redirect is still followed, so a
 * bridge that worked through one still does.
 *
 * Every remote server here is reached through `hop`s: plain HTTP servers that
 * record what they were sent, redirect /moved/... where they are told, and
 * pass everything else on to the real server, headers and all.
 */

const options = { timeout: gatewayTimeout(30000) }
const KEY = 'secret-key-3e7b'
const remoteServer = resolve('tests/helpers/remote-mcp-server.mjs')

interface Seen {
  path: string
  headers: IncomingHttpHeaders
}

// The legacy remote server: Streamable HTTP at /mcp, SSE at /sse.
const legacyRemote = async (t: TestContext) => {
  const port = await unusedPort()
  const child = spawn(process.execPath, [remoteServer], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => {
    child.kill()
  })
  await once(child.stdout, 'data')
  return `http://127.0.0.1:${port}`
}

// A 2026-07-28 remote server: a gateway in front of a 2026-07-28 peer.
const modernRemote = async (t: TestContext) => {
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      'node tests/helpers/modern-bridge-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ],
    { MODERN_WIRE: '1' },
  )
  await gateway.ready()
  return `http://127.0.0.1:${port}`
}

// An origin of its own: a path that `moves` is a 307 to `movedTo` + the
// path, less a /moved prefix; anything else is passed on to `target`.
const hop = async (
  t: TestContext,
  target: string,
  movedTo = '',
  moves = (path: string) => path.startsWith('/moved/'),
) => {
  const seen: Seen[] = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url!, headers: req.headers })
    if (moves(req.url!)) {
      req.resume()
      res.writeHead(307, {
        location: `${movedTo}${req.url!.replace(/^\/moved\//, '/')}`,
      })
      res.end()
      return
    }
    const upstream = httpRequest(
      `${target}${req.url}`,
      {
        method: req.method,
        headers: { ...req.headers, host: new URL(target).host },
      },
      (answer) => {
        res.writeHead(answer.statusCode!, answer.headers)
        answer.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    req.pipe(upstream)
  })
  const port = await unusedPort()
  await new Promise<void>((done) => server.listen(port, '127.0.0.1', done))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  return { base: `http://127.0.0.1:${port}`, seen }
}

// The configured server, at `entry`, redirecting /moved/... to another
// origin (`elsewhere`) that also passes it on to the real server.
const crossOrigin = async (t: TestContext, real: string) => {
  const elsewhere = await hop(t, real)
  const entry = await hop(t, real, elsewhere.base)
  return { entry, elsewhere }
}

// What reached another origin: some requests, none with a configured header.
const noneForwarded = (seen: Seen[]) => {
  assert.ok(seen.length > 0, 'the redirect was followed')
  for (const { path, headers } of seen) {
    assert.equal(headers['x-api-key'], undefined, path)
    assert.equal(headers.authorization, undefined, path)
  }
}

const droppedLine = (entry: string, elsewhere: string) =>
  `${entry} redirected to ${elsewhere}: following it without the configured headers`

const toolNames = (answer: { result: { tools: { name: string }[] } }) =>
  answer.result.tools.map((tool) => tool.name).sort()

// A stdio client of a bridge: initialized, then its tools listed.
const listThroughBridge = async (gateway: ReturnType<typeof launchGateway>) => {
  assert.ok((await stdioRpc(gateway, initialize(1))).result)
  gateway.child.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) +
      '\n',
  )
  return toolNames(
    await stdioRpc(gateway, { jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  )
}

// A 2026-07-28 tools/list to the gateway on `port`, answered with tools.
const modernToolsList = async (port: number) => {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    signal: AbortSignal.timeout(requestTimeout(10000)),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/list',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'r', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  })
  const body = await response.text()
  assert.equal(response.status, 200, body)
  assert.match(body, /"tools"/)
}

// What a hop passed on to the real server, after a redirect within it: every
// request, with the configured key.
const keptTheKey = (seen: Seen[]) => {
  const passedOn = seen.filter((s) => !s.path.startsWith('/moved/'))
  assert.ok(passedOn.length > 0, 'the redirect was followed')
  for (const { path, headers } of passedOn)
    assert.equal(headers['x-api-key'], KEY, path)
  return passedOn
}

const bridged = ['add', 'ask', 'whoami']

test(
  '--streamableHttp: a redirect to another origin is followed without --header',
  options,
  async (t) => {
    const { entry, elsewhere } = await crossOrigin(t, await legacyRemote(t))
    const gateway = launchGateway(t, [
      '--streamableHttp',
      `${entry.base}/moved/mcp`,
      '--header',
      `X-Api-Key: ${KEY}`,
      '--oauth2Bearer',
      KEY,
    ])
    assert.deepEqual(await listThroughBridge(gateway), bridged)
    // The configured server itself is sent them.
    assert.equal(entry.seen[0].headers['x-api-key'], KEY)
    noneForwarded(elsewhere.seen)
    await gateway.waitFor(
      () => gateway.errors().includes(droppedLine(entry.base, elsewhere.base)),
      'the redirect to be logged',
    )
  },
)

test(
  '--streamableHttp: a redirect within the origin keeps --header',
  options,
  async (t) => {
    const entry = await hop(t, await legacyRemote(t))
    const gateway = launchGateway(t, [
      '--streamableHttp',
      `${entry.base}/moved/mcp`,
      '--header',
      `X-Api-Key: ${KEY}`,
    ])
    assert.deepEqual(await listThroughBridge(gateway), bridged)
    const passedOn = entry.seen.filter((s) => !s.path.startsWith('/moved/'))
    assert.ok(passedOn.length > 0)
    for (const { headers } of passedOn) assert.equal(headers['x-api-key'], KEY)
    assert.doesNotMatch(gateway.errors(), /redirected to/)
  },
)

test(
  '--sse: the event stream redirected to another origin is followed without --header',
  options,
  async (t) => {
    const { entry, elsewhere } = await crossOrigin(t, await legacyRemote(t))
    const gateway = launchGateway(t, [
      '--sse',
      `${entry.base}/moved/sse`,
      '--header',
      `X-Api-Key: ${KEY}`,
    ])
    assert.deepEqual(await listThroughBridge(gateway), bridged)
    noneForwarded(elsewhere.seen)
    // The messages go to the endpoint the stream named, on the configured
    // server, which is sent them.
    const messages = entry.seen.filter((s) => s.path.startsWith('/message'))
    assert.ok(messages.length > 0)
    for (const { headers } of messages) assert.equal(headers['x-api-key'], KEY)
  },
)

test(
  '--sse: a message redirected to another origin is sent without --header',
  options,
  async (t) => {
    const real = await legacyRemote(t)
    const elsewhere = await hop(t, real)
    // The stream is the configured server's own; its messages are redirected.
    const entry = await hop(t, real, elsewhere.base, (path) =>
      path.startsWith('/message'),
    )
    const gateway = launchGateway(t, [
      '--sse',
      `${entry.base}/sse`,
      '--header',
      `X-Api-Key: ${KEY}`,
    ])
    assert.deepEqual(await listThroughBridge(gateway), bridged)
    assert.equal(entry.seen[0].path, '/sse')
    assert.equal(entry.seen[0].headers['x-api-key'], KEY)
    noneForwarded(elsewhere.seen)
    assert.ok(elsewhere.seen.every((s) => s.path.startsWith('/message')))
  },
)

const writeConfig = (t: TestContext, value: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-redirect-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }))
  const path = join(dir, 'servers.json')
  writeFileSync(path, JSON.stringify(value, null, 2))
  return path
}

test(
  'a url entry, over Streamable HTTP and SSE: another origin is not sent its headers',
  options,
  async (t) => {
    const real = await legacyRemote(t)
    const { entry, elsewhere } = await crossOrigin(t, real)
    const port = await unusedPort()
    const headers = { 'X-Api-Key': KEY }
    const gateway = launchGateway(t, [
      '--config',
      writeConfig(t, {
        port,
        mcpServers: {
          http: {
            url: `${entry.base}/moved/mcp`,
            type: 'http',
            headers,
            outputTransport: 'streamableHttp',
          },
          events: {
            url: `${entry.base}/moved/sse`,
            type: 'sse',
            headers,
            outputTransport: 'streamableHttp',
          },
        },
      }),
    ])
    await gateway.ready()
    // Two sessions of each.
    for (const name of ['http', 'events', 'http', 'events']) {
      const client = new Client({ name: 'redirects', version: '1.0.0' })
      t.after(() => client.close())
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/${name}/mcp`),
        ),
      )
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map((tool) => tool.name).sort(), bridged, name)
    }
    noneForwarded(elsewhere.seen)
    assert.ok(elsewhere.seen.some((s) => s.path === '/mcp'))
    assert.ok(elsewhere.seen.some((s) => s.path === '/sse'))
    assert.equal(
      gateway
        .errors()
        .split('\n')
        .filter((line) =>
          line.includes(droppedLine(entry.base, elsewhere.base)),
        ).length,
      2,
      'logged once for each remote server, not per session',
    )
  },
)

test(
  'the 2026-07-28 relay: server/discover and relayed requests are not sent --header elsewhere',
  options,
  async (t) => {
    const { entry, elsewhere } = await crossOrigin(t, await modernRemote(t))
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--streamableHttp',
      `${entry.base}/moved/mcp`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      '--header',
      `X-Api-Key: ${KEY}`,
    ])
    await gateway.ready()
    await modernToolsList(port)
    noneForwarded(elsewhere.seen)
    const methods = elsewhere.seen.map((s) => s.headers['mcp-method'])
    assert.ok(methods.includes('server/discover'), String(methods))
    assert.ok(methods.includes('tools/list'), String(methods))
  },
)

test(
  'a url entry over SSE: a message redirected to another origin is sent without its headers',
  options,
  async (t) => {
    const real = await legacyRemote(t)
    const elsewhere = await hop(t, real)
    const entry = await hop(t, real, elsewhere.base, (path) =>
      path.startsWith('/message'),
    )
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--config',
      writeConfig(t, {
        port,
        mcpServers: {
          events: {
            url: `${entry.base}/sse`,
            type: 'sse',
            headers: { 'X-Api-Key': KEY },
            outputTransport: 'streamableHttp',
          },
        },
      }),
    ])
    await gateway.ready()
    const client = new Client({ name: 'redirects', version: '1.0.0' })
    t.after(() => client.close())
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/events/mcp`),
      ),
    )
    const { tools } = await client.listTools()
    assert.deepEqual(tools.map((tool) => tool.name).sort(), bridged)
    assert.equal(entry.seen[0].headers['x-api-key'], KEY)
    noneForwarded(elsewhere.seen)
    assert.ok(elsewhere.seen.every((s) => s.path.startsWith('/message')))
  },
)

// Within the origin, as a remote server that moved a path has always been
// followed: every way of reaching one still sends it the configured headers.

test(
  '--sse: a redirect within the origin keeps --header',
  options,
  async (t) => {
    const entry = await hop(t, await legacyRemote(t))
    const gateway = launchGateway(t, [
      '--sse',
      `${entry.base}/moved/sse`,
      '--header',
      `X-Api-Key: ${KEY}`,
    ])
    assert.deepEqual(await listThroughBridge(gateway), bridged)
    const passedOn = keptTheKey(entry.seen)
    assert.ok(passedOn.some((s) => s.path === '/sse'))
    assert.ok(passedOn.some((s) => s.path.startsWith('/message')))
    assert.doesNotMatch(gateway.errors(), /redirected to/)
  },
)

test(
  'a url entry, over Streamable HTTP and SSE: a redirect within the origin keeps its headers',
  options,
  async (t) => {
    const entry = await hop(t, await legacyRemote(t))
    const port = await unusedPort()
    const headers = { 'X-Api-Key': KEY }
    const gateway = launchGateway(t, [
      '--config',
      writeConfig(t, {
        port,
        mcpServers: {
          http: {
            url: `${entry.base}/moved/mcp`,
            type: 'http',
            headers,
            outputTransport: 'streamableHttp',
          },
          events: {
            url: `${entry.base}/moved/sse`,
            type: 'sse',
            headers,
            outputTransport: 'streamableHttp',
          },
        },
      }),
    ])
    await gateway.ready()
    for (const name of ['http', 'events']) {
      const client = new Client({ name: 'redirects', version: '1.0.0' })
      t.after(() => client.close())
      await client.connect(
        new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/${name}/mcp`),
        ),
      )
      const { tools } = await client.listTools()
      assert.deepEqual(tools.map((tool) => tool.name).sort(), bridged, name)
    }
    const passedOn = keptTheKey(entry.seen)
    assert.ok(passedOn.some((s) => s.path === '/mcp'))
    assert.ok(passedOn.some((s) => s.path === '/sse'))
    assert.doesNotMatch(gateway.errors(), /redirected to/)
  },
)

test(
  'the 2026-07-28 relay: a redirect within the origin keeps --header',
  options,
  async (t) => {
    const entry = await hop(t, await modernRemote(t))
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--streamableHttp',
      `${entry.base}/moved/mcp`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      '--header',
      `X-Api-Key: ${KEY}`,
    ])
    await gateway.ready()
    await modernToolsList(port)
    const methods = keptTheKey(entry.seen).map((s) => s.headers['mcp-method'])
    assert.ok(methods.includes('server/discover'), String(methods))
    assert.ok(methods.includes('tools/list'), String(methods))
    assert.doesNotMatch(gateway.errors(), /redirected to/)
  },
)
