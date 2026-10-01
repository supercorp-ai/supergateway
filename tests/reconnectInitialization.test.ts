import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { execFileSync } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20.
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * GW-034: since 4.1.0 each SSE and WebSocket connection has its own child, so
 * a client that reconnects gets a new one. The TypeScript SDK's SSE client
 * reconnects by itself after any dropped stream and carries on without a
 * second initialize. The new child had never been initialized, and a server
 * that enforces the handshake (every Python SDK server) refused each call with
 * "Invalid request parameters". The gateway now initializes such a child
 * itself before forwarding.
 *
 * `strict-init-peer.mjs` refuses requests the way the Python SDK does and
 * reports who initialized it, so these tests fail without the fix.
 */
const strictPeer = 'node tests/helpers/strict-init-peer.mjs'

type Stream = { frames: string[]; endpoint: string; close: () => void }

const openSse = async (
  port: number,
  waitFor: (predicate: () => boolean, description: string) => Promise<void>,
): Promise<Stream> => {
  const controller = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/sse`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  })
  assert.equal(response.status, 200)
  const frames: string[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  void (async () => {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines)
        if (line.startsWith('data:')) frames.push(line.slice(5).trim())
    }
  })().catch(() => {})
  await waitFor(
    () => frames.some((frame) => frame.startsWith('/message')),
    'announce a message endpoint',
  )
  return {
    frames,
    endpoint: frames.find((frame) => frame.startsWith('/message'))!,
    close: () => controller.abort(),
  }
}

const post = (
  port: number,
  endpoint: string,
  message: object,
  headers: Record<string, string> = {},
) =>
  fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(message),
  })

const replyTo = (frames: string[], id: number) =>
  frames
    .map((frame) => {
      try {
        return JSON.parse(frame)
      } catch {
        return undefined
      }
    })
    .find((message) => message?.id === id)

test(
  'an SSE client that reconnects without initializing is served by an initialized server',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      strictPeer,
      '--port',
      String(port),
    ])
    await gateway.ready()

    // The first connection initializes as any client does.
    const first = await openSse(port, gateway.waitFor)
    await post(port, first.endpoint, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'sdk-client', version: '1' },
      },
    })
    await post(port, first.endpoint, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    await post(port, first.endpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
    })
    await gateway.waitFor(
      () => !!replyTo(first.frames, 1),
      'answer the first call',
    )
    assert.equal(
      replyTo(first.frames, 1).result.content[0].text,
      'initialized by sdk-client with 2025-06-18; initialize x1; initialized x1',
      "a client's own handshake is passed through, and nothing is added to it",
    )
    first.close()

    // The stream drops; the client reopens it and carries on where it was,
    // naming the version it negotiated, as the SDK's SSE client does.
    const second = await openSse(port, gateway.waitFor)
    assert.notEqual(second.endpoint, first.endpoint)
    await post(
      port,
      second.endpoint,
      { jsonrpc: '2.0', id: 2, method: 'tools/call' },
      { 'mcp-protocol-version': '2025-06-18' },
    )
    await post(port, second.endpoint, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })
    await gateway.waitFor(
      () => !!replyTo(second.frames, 2) && !!replyTo(second.frames, 3),
      'answer the reconnected client',
    )
    assert.equal(
      replyTo(second.frames, 2).result?.content[0].text,
      'initialized by supergateway with 2025-06-18; initialize x1; initialized x1',
    )
    assert.ok(replyTo(second.frames, 3).result, 'and every call after it')
    assert.ok(
      !second.frames.some((frame) => frame.includes('supergateway-initialize')),
      "the answer to the gateway's own initialize never reaches the client",
    )
    second.close()
  },
)

/**
 * The same, with the real SDK client and a real dropped connection: a proxy
 * in front of the gateway cuts every socket, as an idle timeout at a load
 * balancer or a tunnel does, and the client reconnects on its own.
 */
test(
  "the SDK's SSE client keeps working after its connection is cut",
  { timeout: gatewayTimeout(60000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      strictPeer,
      '--port',
      String(port),
    ])
    await gateway.ready()

    const sockets = new Set<net.Socket>()
    const proxy = net.createServer((downstream) => {
      const upstream = net.connect(port, '127.0.0.1')
      for (const [a, b] of [
        [downstream, upstream],
        [upstream, downstream],
      ]) {
        sockets.add(a)
        a.pipe(b)
        a.on('error', () => b.destroy())
        a.on('close', () => {
          sockets.delete(a)
          b.destroy()
        })
      }
    })
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    t.after(() => proxy.close())
    const proxyPort = (proxy.address() as net.AddressInfo).port

    const transport = new SSEClientTransport(
      new URL(`http://127.0.0.1:${proxyPort}/sse`),
    )
    const client = new Client({ name: 'sdk-client', version: '1' })
    await client.connect(transport)
    t.after(() => client.close())
    const call = async () =>
      (
        (await client.callTool({ name: 'whoami', arguments: {} })) as {
          content: { text: string }[]
        }
      ).content[0].text
    assert.match(await call(), /^initialized by sdk-client /)

    // The transport's endpoint is the only sign that it has moved to a new
    // session; it is private, and read here for that reason alone.
    const endpoint = () =>
      (transport as unknown as { _endpoint?: URL })._endpoint?.href
    const original = endpoint()
    for (const socket of sockets) socket.destroy()
    await gateway.waitFor(
      () => (gateway.output().match(/New SSE connection/g) ?? []).length === 2,
      'see the client reconnect',
    )
    await gateway.waitFor(
      () => endpoint() !== original,
      'let the client adopt its new endpoint',
    )
    assert.match(
      await call(),
      /^initialized by supergateway /,
      'the reconnected session is served, by a server the gateway initialized',
    )
  },
)

test(
  'a WebSocket client that reconnects without initializing is served by an initialized server',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      strictPeer,
      '--outputTransport',
      'ws',
      '--port',
      String(port),
    ])
    await gateway.ready()

    const ws = new WebSocket(`ws://127.0.0.1:${port}/message`)
    t.after(() => ws.terminate())
    const received: {
      id?: unknown
      result?: { content: { text: string }[] }
    }[] = []
    ws.on('message', (data) => received.push(JSON.parse(data.toString())))
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call' }))
    ws.send(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    )
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call' }))
    await gateway.waitFor(
      () =>
        received.filter((message) => message.id === 5 || message.id === 6)
          .length === 2,
      'answer the client',
    )
    assert.deepEqual(
      received.map((message) => message.result?.content[0].text),
      [
        'initialized by supergateway with 2024-11-05; initialize x1; initialized x1',
        'initialized by supergateway with 2024-11-05; initialize x1; initialized x1',
      ],
      "only the client's calls come back, and its own initialized notification is not a second one",
    )
  },
)

// The server the defect was found with. CI installs `mcp` where it runs Python.
const python = process.env.SUPERGATEWAY_TEST_PYTHON ?? 'python3'
const pythonAvailable = (() => {
  try {
    execFileSync(python, ['-c', 'import mcp'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
if (process.env.SUPERGATEWAY_REQUIRE_PYTHON === '1' && !pythonAvailable)
  throw new Error(`${python} cannot import mcp`)

test(
  'a Python server answers an SSE client that reconnected without initializing',
  {
    timeout: gatewayTimeout(60000),
    skip: pythonAvailable ? false : `${python} has no mcp package`,
  },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      `${python} tests/helpers/python-mcp-server.py`,
      '--port',
      String(port),
    ])
    await gateway.ready()
    const stream = await openSse(port, gateway.waitFor)
    await post(port, stream.endpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 2, b: 3 } },
    })
    await gateway.waitFor(() => !!replyTo(stream.frames, 1), 'answer the call')
    assert.equal(
      replyTo(stream.frames, 1).result?.content[0].text,
      'The sum of 2 and 3 is 5.',
    )
    stream.close()
  },
)
