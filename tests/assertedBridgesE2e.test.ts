import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'

// The bridges (--sse and --streamableHttp: a remote server served to a stdio
// client), end to end against the built CLI and a real remote MCP server:
// what they log about the messages the server sends, and how the Streamable
// HTTP bridge reconnects in the background after it loses its upstream.

const remoteServer = resolve('tests/helpers/remote-mcp-server.mjs')
const options = { timeout: gatewayTimeout(60000) }

// The remote server on `port`, running until it is stopped or the test ends.
// Started again on the same port, it is the same server restarted.
const startRemote = async (t: TestContext, port: number) => {
  const child = spawn(process.execPath, [remoteServer], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  t.after(() => {
    child.kill()
  })
  await once(child.stdout, 'data')
  return child
}

const stopRemote = async (child: ChildProcess) => {
  child.kill()
  if (child.exitCode === null && child.signalCode === null)
    await once(child, 'exit')
}

const stats = async (port: number) =>
  (await (await fetch(`http://127.0.0.1:${port}/stats`)).json()) as {
    opened: number
    closed: number
  }

type Bridge = ReturnType<typeof launchGateway>

// The bridge's log, one JSON object per line on stderr.
const logs = (bridge: Bridge) =>
  bridge
    .errors()
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map(
      (line) =>
        JSON.parse(line) as {
          level: string
          msg: string
          data?: any
        },
    )

const logged = (bridge: Bridge, msg: string) =>
  logs(bridge).filter((entry) => entry.msg === msg)

const bridgeTo = async (t: TestContext, flag: string, url: string) => {
  const bridge = launchGateway(t, [flag, url, '--logFormat', 'json'])
  await bridge.ready()
  return bridge
}

const initialize = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: { sampling: {} },
    clientInfo: { name: 'e2e', version: '1.0.0' },
  },
})

const add = (id: number) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name: 'add', arguments: { a: 1, b: 2 } },
})

for (const { flag, path, label } of [
  { flag: '--sse', path: '/sse', label: 'SSE' },
  { flag: '--streamableHttp', path: '/mcp', label: 'Streamable HTTP' },
]) {
  test(
    `${flag} bridge logs each message the server sends the stdio client`,
    options,
    async (t) => {
      const port = await unusedPort()
      await startRemote(t, port)
      const bridge = await bridgeTo(t, flag, `http://127.0.0.1:${port}${path}`)
      assert.ok((await stdioRpc(bridge, initialize(1))).result)
      // `ask` has the server ask the client to sample before it answers.
      bridge.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'ask', arguments: {} },
        }) + '\n',
      )
      const asked = () =>
        bridge
          .output()
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line))
          .find((message) => message.method === 'sampling/createMessage')
      await bridge.waitFor(() => Boolean(asked()), 'relay the server request')
      const request = asked()
      bridge.child.stdin.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: {
            model: 'offline-stub',
            role: 'assistant',
            content: { type: 'text', text: 'pong' },
          },
        }) + '\n',
      )
      await bridge.waitFor(
        () => bridge.output().includes('client said pong'),
        'answer the tool call',
      )
      // map: the server's request is logged as it is relayed, exactly as the
      // stdio client received it
      assert.deepEqual(
        logged(bridge, `${label} → Stdio:`).map(({ level, data }) => ({
          level,
          data,
        })),
        [{ level: 'info', data: request }],
      )
    },
  )
}

test(
  '--streamableHttp bridge retries a lost upstream in the background, logging each failure, backing off, and starting over once reconnected',
  options,
  async (t) => {
    const port = await unusedPort()
    let remote = await startRemote(t, port)
    const bridge = await bridgeTo(
      t,
      '--streamableHttp',
      `http://127.0.0.1:${port}/mcp`,
    )
    assert.ok((await stdioRpc(bridge, initialize(1))).result)
    const failures = () => logged(bridge, 'Streamable HTTP reconnect failed:')
    const connected = () => logged(bridge, 'Streamable HTTP connected').length

    await stopRemote(remote)
    // The request that finds the upstream gone fails, and schedules the
    // background reconnect: one second, then two, then four.
    assert.ok((await stdioRpc(bridge, add(2))).error)
    await bridge.waitFor(() => failures().length === 2, 'retry twice')
    // map: every failed background reconnect is logged with its error
    assert.deepEqual(
      failures().map(({ level, data }) => ({
        level,
        name: data.name,
        message: data.message,
      })),
      [
        { level: 'error', name: 'TypeError', message: 'fetch failed' },
        { level: 'error', name: 'TypeError', message: 'fetch failed' },
      ],
    )

    // Back before the third attempt, four seconds after the second.
    remote = await startRemote(t, port)
    await bridge.waitFor(() => connected() === 2, 'reconnect in the background')
    assert.equal(failures().length, 2)

    await stopRemote(remote)
    assert.ok((await stdioRpc(bridge, add(3))).error)
    const lost = Date.now()
    await bridge.waitFor(() => failures().length === 3, 'retry again')
    // map: a successful reconnect resets the backoff. The next loss is retried
    // after one second again, not the four the backoff had reached.
    const waited = Date.now() - lost
    assert.ok(
      waited < 2500,
      `retried ${waited}ms after the loss; one second was due`,
    )
  },
)

test(
  '--streamableHttp bridge: a request that reconnects first cancels the background reconnect',
  options,
  async (t) => {
    const port = await unusedPort()
    let remote = await startRemote(t, port)
    const bridge = await bridgeTo(
      t,
      '--streamableHttp',
      `http://127.0.0.1:${port}/mcp`,
    )
    assert.ok((await stdioRpc(bridge, initialize(1))).result)

    // Restarted, the server no longer knows the bridge's session: the next
    // request is refused with a 404 and schedules a reconnect a second later.
    await stopRemote(remote)
    remote = await startRemote(t, port)
    assert.ok((await stdioRpc(bridge, add(2))).error)
    const lost = Date.now()
    // The request after it reconnects at once.
    assert.deepEqual((await stdioRpc(bridge, add(3))).result.content, [
      { type: 'text', text: '3' },
    ])
    assert.equal((await stats(port)).opened, 1)

    // A reconnect that does not happen can only be seen by waiting past the
    // moment it was due: one second after the loss, here given a second more.
    await delay(Math.max(0, lost + 1000 + requestTimeout(1000) - Date.now()))
    // map: the scheduled reconnect was cancelled, so no second session was
    // opened behind the one the request made
    assert.deepEqual(
      {
        connected: logged(bridge, 'Streamable HTTP connected').length,
        opened: (await stats(port)).opened,
      },
      { connected: 2, opened: 1 },
    )
    assert.deepEqual((await stdioRpc(bridge, add(4))).result.content, [
      { type: 'text', text: '3' },
    ])
  },
)
