import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

test(
  'a proxy-held GET is closed after its downstream client disappears',
  { timeout: 110000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/session-state-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '5000',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const gatewayUrl = `http://127.0.0.1:${port}/mcp`
    const opened = await rpc(gatewayUrl, initialize())
    const session = opened.response.headers.get('mcp-session-id')!
    assert.ok(session)
    assert.equal(
      (
        await rpc(
          gatewayUrl,
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          session,
        )
      ).response.status,
      202,
    )

    let downstreamGone = false
    const upstreamRequests: ReturnType<typeof httpRequest>[] = []
    const proxy = createServer((req, res) => {
      const upstream = httpRequest({
        hostname: '127.0.0.1',
        port,
        path: req.url,
        method: req.method,
        headers: req.headers,
      })
      upstreamRequests.push(upstream)
      upstream.on('response', (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
        res.once('close', () => {
          if (req.method !== 'GET') return
          downstreamGone = true
          // Deliberately retain and drain the upstream connection. This is the
          // failure mode a gateway cannot detect from TCP close events alone.
          response.unpipe(res)
          response.resume()
        })
      })
      upstream.on('error', () => res.destroy())
      req.pipe(upstream)
    })
    proxy.listen(0, '127.0.0.1')
    await once(proxy, 'listening')
    t.after(async () => {
      for (const request of upstreamRequests) request.destroy()
      proxy.closeAllConnections()
      await new Promise<void>((resolve) => proxy.close(() => resolve()))
    })
    const address = proxy.address()
    assert.ok(address && typeof address !== 'string')
    const abort = new AbortController()
    const response = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': session },
      signal: abort.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let pingId: string | undefined
    while (!pingId) {
      const { value, done } = await reader.read()
      assert.equal(done, false, 'the first liveness ping must reach the client')
      buffer += decoder.decode(value, { stream: true })
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const data = frame.split('\n').find((line) => line.startsWith('data:'))
        if (!data) continue
        const message = JSON.parse(data.slice(5))
        if (message.method === 'ping') pingId = message.id
      }
    }
    const pong = await fetch(`http://127.0.0.1:${address.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': session,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: pingId, result: {} }),
      signal: AbortSignal.timeout(5000),
    })
    assert.equal(pong.status, 202)
    await pong.text()
    abort.abort()
    const waitFor = async (needle: string, milliseconds: number) => {
      const deadline = Date.now() + milliseconds
      while (!gateway.output().includes(needle)) {
        assert.ok(Date.now() < deadline, gateway.output())
        await delay(100)
      }
    }
    const goneDeadline = Date.now() + 3000
    while (!downstreamGone) {
      assert.ok(Date.now() < goneDeadline)
      await delay(10)
    }
    await waitFor('Sending session liveness ping', 3000)
    assert.equal(
      gateway.output().includes('GET response closed'),
      false,
      'the proxy still holds the gateway-side GET open',
    )
    await waitFor('Closing session after two unanswered liveness pings', 30000)
    await waitFor(`StreamableHttp connection closed (session ${session})`, 3000)
    const expired = await rpc(
      gatewayUrl,
      { jsonrpc: '2.0', id: 9, method: 'tools/list' },
      session,
    )
    assert.equal(expired.response.status, 404)
  },
)
