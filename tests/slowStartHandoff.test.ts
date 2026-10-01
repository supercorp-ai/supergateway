import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20.
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * GW-035: since 4.1.0 every SSE and WebSocket connection starts its own server.
 * A server that starts more slowly than the client waits for initialize (5 s in
 * pydantic-ai) used to work on the retry, because the one shared server was up
 * by then; with one per connection every retry started from cold and timed out
 * the same way. A child whose client left during initialize now waits briefly
 * for an identical retry, which takes it over.
 */
const startup = requestTimeout(3000)
const slowPeer = `node tests/helpers/slow-start-peer.mjs ${startup}`

const sdkClient = (port: number, name = 'retrying-agent') => {
  const client = new Client({ name, version: '1' })
  return {
    client,
    connect: (timeout: number) =>
      client.connect(
        new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)),
        { timeout },
      ),
  }
}

test(
  'a retry takes over the server its timed-out predecessor started',
  { timeout: gatewayTimeout(60000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      slowPeer,
      '--port',
      String(port),
    ])
    await gateway.ready()

    // Gives up a third of the way into the server's startup.
    const first = sdkClient(port)
    await assert.rejects(first.connect(requestTimeout(1000)), /timed out/i)
    await first.client.close()

    // Waits less than a whole startup, so a fresh server could never answer
    // it in time. The one already starting can.
    const retry = sdkClient(port)
    t.after(() => retry.client.close())
    await retry.connect(requestTimeout(2500))
    const pid = retry.client.getServerVersion()!.version
    const called = (await retry.client.callTool({
      name: 'whoami',
      arguments: {},
    })) as { content: { text: string }[] }
    assert.equal(called.content[0].text, `pid ${pid}`)
    assert.match(
      gateway.output(),
      /client left before its initialize was answered; keeping the server/,
    )
    assert.match(
      gateway.output(),
      /took over a server whose previous client left/,
    )
    // The retry's own server was started on connect, as always, and stopped
    // unused once it took the other one over.
    await gateway.waitFor(
      () => /unused server stopped/.test(gateway.output()),
      "stop the retry's own server",
    )
  },
)

test(
  'a different client never takes over a waiting server',
  { timeout: gatewayTimeout(60000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      slowPeer,
      '--port',
      String(port),
    ])
    await gateway.ready()

    const first = sdkClient(port, 'agent-one')
    await assert.rejects(first.connect(requestTimeout(1000)), /timed out/i)
    await first.client.close()
    await gateway.waitFor(
      () => /keeping the server/.test(gateway.output()),
      'keep the abandoned server for a retry',
    )

    const other = sdkClient(port, 'agent-two')
    t.after(() => other.client.close())
    await other.connect(requestTimeout(10000))
    assert.doesNotMatch(gateway.output(), /took over/)
  },
)

test(
  'a client that sent more than initialize leaves nothing waiting',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      slowPeer,
      '--port',
      String(port),
    ])
    await gateway.ready()
    const controller = new AbortController()
    const response = await fetch(`http://127.0.0.1:${port}/sse`, {
      signal: controller.signal,
    })
    const reader = response.body!.getReader()
    let text = ''
    while (!/sessionId=/.test(text))
      text += new TextDecoder().decode((await reader.read()).value)
    const endpoint = /data: (\/message\?sessionId=\S+)/.exec(text)![1]
    const post = (message: object) =>
      fetch(`http://127.0.0.1:${port}${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      })
    await post({
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'x', version: '1' },
      },
    })
    await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    controller.abort()
    await gateway.waitFor(
      () => /Child exited \(session/.test(gateway.output()),
      'stop its server at once, as before',
    )
    assert.doesNotMatch(gateway.output(), /keeping the server/)
  },
)

test(
  'a WebSocket retry takes over the server its predecessor started',
  { timeout: gatewayTimeout(60000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      slowPeer,
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const initialize = (id: number) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'ws-agent', version: '1' },
        },
      })
    const open = async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/message`)
      const received: any[] = []
      ws.on('message', (data) => received.push(JSON.parse(data.toString())))
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      return { ws, received }
    }

    const first = await open()
    first.ws.send(initialize(0))
    first.ws.close()
    await gateway.waitFor(
      () => /keeping the server/.test(gateway.output()),
      'keep the abandoned server for a retry',
    )

    const retry = await open()
    t.after(() => retry.ws.terminate())
    retry.ws.send(initialize(7))
    await gateway.waitFor(
      () => retry.received.some((message) => message.id === 7),
      'answer the retry',
    )
    const answer = retry.received.find((message) => message.id === 7)
    retry.ws.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )
    retry.ws.send(
      JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call' }),
    )
    await gateway.waitFor(
      () => retry.received.some((message) => message.id === 8),
      'serve the retry',
    )
    assert.equal(
      retry.received.find((message) => message.id === 8).result.content[0].text,
      `pid ${answer.result.serverInfo.version}`,
    )
    assert.match(gateway.output(), /took over a server/)
    assert.deepEqual(first.received, [], 'the client that left got nothing')
  },
)
