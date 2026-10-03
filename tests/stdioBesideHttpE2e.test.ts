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
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  requestTimeout,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'
import { descendantsOf } from './helpers/process-tree.js'

// One remote entry on stdio beside entries served over HTTP: the config file
// a desktop client launches, which also serves other clients on a port. The
// process is the stdio client's: however it ends, it ends for every entry.

const prefix = '[supergateway] '
const node = process.execPath
const mockServer = resolve('tests/helpers/mock-mcp-server.js')
const remoteServer = resolve('tests/helpers/remote-mcp-server.mjs')
const options = { timeout: gatewayTimeout(30000) }

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

// The gateway with `far` on stdio and `near`, a local server, over SSE.
const launch = async (
  t: TestContext,
  far: Record<string, unknown>,
  early?: unknown,
) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-beside-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'servers.json')
  const port = await unusedPort()
  writeFileSync(
    file,
    JSON.stringify({
      port,
      // The HTTP entry first: the stdio one's place must not decide where
      // the gateway logs.
      mcpServers: {
        near: { command: node, args: [mockServer, 'stdio'] },
        far: { ...far, outputTransport: 'stdio' },
      },
    }),
  )
  const gateway = launchGateway(t, ['--config', file])
  // Written before the gateway is up, as a desktop client does: none of it
  // may be read and dropped before the bridge reads stdin.
  if (early) gateway.child.stdin.write(`${JSON.stringify(early)}\n`)
  await gateway.ready()
  return { gateway, port }
}

// A client of the HTTP entry, holding a session and so a running server.
const holdSession = async (t: TestContext, port: number) => {
  const client = new Client({ name: 'near', version: '1.0.0' })
  t.after(() => client.close())
  await client.connect(
    new SSEClientTransport(new URL(`http://127.0.0.1:${port}/near/sse`)),
  )
  assert.deepEqual(
    (await client.listTools()).tools.map((tool) => tool.name),
    ['add'],
  )
  return client
}

const exit = async (gateway: Gateway) =>
  Promise.race([
    gateway.exited,
    delay(requestTimeout(10000), 'still running' as const, { ref: false }),
  ])

// Nothing the gateway started outlives it.
const leftBehind = async (gateway: Gateway) => {
  const deadline = Date.now() + requestTimeout(5000)
  for (;;) {
    const left = descendantsOf(gateway.child.pid!, {
      since: gateway.spawnedAt,
    })
    if (left.length === 0 || Date.now() > deadline) return left
    await delay(50)
  }
}

test(
  "both are served, and stdout carries only the stdio entry's messages",
  options,
  async (t) => {
    const up = await remote(t)
    const { gateway, port } = await launch(
      t,
      { url: `${up.base}/mcp`, type: 'streamableHttp' },
      initialize(),
    )
    await holdSession(t, port)
    const answer = () =>
      gateway
        .output()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
        .find((message) => message.id === 1)
    await gateway.waitFor(
      () => Boolean(answer()),
      'answer the early initialize',
    )
    assert.equal(answer().result.serverInfo.name, 'remote-server')
    const listed = await stdioRpc(gateway, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    assert.deepEqual(
      listed.result.tools.map((tool: { name: string }) => tool.name),
      ['add', 'whoami', 'ask'],
    )
    // Every line on stdout is an MCP message; the listing is on stderr.
    for (const line of gateway.output().trim().split('\n'))
      assert.equal(JSON.parse(line).jsonrpc, '2.0', line)
    const listing = gateway.errors()
    for (const line of [
      `${prefix}[near]   - path: /near`,
      `${prefix}[far]   - outputTransport: stdio`,
      `${prefix}[far]   - streamableHttp: ${up.base}/mcp`,
      `${prefix}Listening on port ${port}`,
    ])
      assert.ok(listing.includes(`${line}\n`), `${line} in:\n${listing}`)
  },
)

test('stdin closing stops every entry', options, async (t) => {
  const up = await remote(t)
  const { gateway, port } = await launch(t, {
    url: `${up.base}/mcp`,
    type: 'streamableHttp',
  })
  await holdSession(t, port)
  await stdioRpc(gateway, initialize())
  gateway.child.stdin.end()
  assert.deepEqual(await exit(gateway), { code: 0, signal: null })
  assert.match(gateway.errors(), /stdin closed\. Exiting\.\.\./)
  assert.deepEqual(await leftBehind(gateway), [])
})

test(
  "a signal stops every entry, and ends the stdio entry's remote session",
  options,
  async (t) => {
    const up = await remote(t)
    const { gateway, port } = await launch(t, {
      url: `${up.base}/mcp`,
      type: 'streamableHttp',
    })
    await holdSession(t, port)
    await stdioRpc(gateway, initialize())
    // The gateway alone, not its process group: what it stops, it stops itself.
    process.kill(gateway.child.pid!, 'SIGTERM')
    assert.deepEqual(await exit(gateway), { code: 0, signal: null })
    assert.deepEqual(await leftBehind(gateway), [])
    const stats = await up.stats()
    assert.deepEqual(stats, { ...stats, opened: 1, closed: 1 })
  },
)

test(
  'a stdio entry whose remote server refuses it stops every entry, with code 1',
  options,
  async (t) => {
    // Nothing listens there: the first handshake fails.
    const closed = await unusedPort()
    const { gateway, port } = await launch(t, {
      url: `http://127.0.0.1:${closed}/mcp`,
      type: 'streamableHttp',
    })
    await holdSession(t, port)
    gateway.child.stdin.write(`${JSON.stringify(initialize())}\n`)
    assert.deepEqual(await exit(gateway), { code: 1, signal: null })
    assert.match(gateway.errors(), /far on stdio stopped\. Exiting\.\.\./)
    assert.deepEqual(await leftBehind(gateway), [])
  },
)
