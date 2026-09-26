import { test } from 'node:test'
import assert from 'node:assert/strict'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20.
import { WebSocket } from 'ws'
import {
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// Express only matches routes that start with `/`, so a path flag written
// without one (`--ssePath sse`) registered a route nothing could reach: every
// request got a 404 and the startup log printed `http://localhost:8000sse`.
const launch = async (
  t: Parameters<typeof launchGateway>[0],
  args: string[],
) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--port',
    String(port),
    '--healthEndpoint',
    'health',
    ...args,
  ])
  await gateway.ready()
  const base = `http://127.0.0.1:${port}`
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  assert.equal(await health.text(), 'ok')
  return { base, port, gateway }
}

test(
  'SSE paths without a leading slash still route',
  { timeout: 20000 },
  async (t) => {
    const { base, gateway } = await launch(t, [
      '--ssePath',
      'sse',
      '--messagePath',
      'message',
    ])
    assert.match(
      gateway.output() + gateway.errors(),
      /SSE endpoint: http:\/\/localhost:\d+\/sse\b/,
    )
    const response = await fetch(`${base}/sse`, {
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const { value } = await reader.read()
    await reader.cancel()
    assert.match(new TextDecoder().decode(value), /data: \/message\?sessionId=/)
  },
)

test(
  'a WebSocket path without a leading slash still routes',
  { timeout: 20000 },
  async (t) => {
    const { port } = await launch(t, [
      '--outputTransport',
      'ws',
      '--messagePath',
      'message',
    ])
    const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
    t.after(() => socket.close())
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })
  },
)

test(
  'a Streamable HTTP path without a leading slash still routes',
  { timeout: 20000 },
  async (t) => {
    const { base } = await launch(t, [
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--streamableHttpPath',
      'mcp',
    ])
    const init = await rpc(`${base}/mcp`, initialize())
    assert.equal(init.response.status, 200)
    assert.equal(init.messages[0].result.serverInfo.name, 'mock-server')
  },
)
