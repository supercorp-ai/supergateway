import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { request, type IncomingMessage } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import { faultControl } from './helpers/fault-control.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

// GW-033. A client that stops reading must hold its own child, the way pipe()
// does, instead of the gateway reading the child's whole output into memory.
// Without the hold the peer's 32 MiB burst finishes in well under a second
// while nobody reads it (a 128 MiB one took the SSE gateway to 327 MiB); with
// it, the peer stays blocked on its stdout until the client reads again, and
// then every notification arrives once, in order.
const COUNT = 2048
const HELD_FOR = 1500

// A client of one mode with the burst call in flight and its reading paused.
type Reader = {
  pause: () => void
  resume: () => void
  received: () => number
  answered: () => boolean
}

// Parses what the client reads, checking the peer's sequence as it goes.
function collect() {
  let seq = 0
  let answered = false
  const message = (text: string) => {
    const message = JSON.parse(text)
    if (message.method === 'notifications/message')
      assert.equal(message.params.logger, String(seq++), 'in order, once each')
    else if (message.id === 'burst') answered = true
  }
  let buffer = ''
  const sse = (chunk: string) => {
    buffer += chunk
    let end: number
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
      buffer = buffer.slice(end + 2)
      if (data?.trim().startsWith('{')) message(data)
    }
  }
  return { message, sse, received: () => seq, answered: () => answered }
}

const burst = {
  jsonrpc: '2.0',
  id: 'burst',
  method: 'tools/call',
  params: { name: 'burst', arguments: { count: COUNT } },
}

// POST a message and stream the SSE response it opens.
function stream(
  t: TestContext,
  url: string,
  body: object,
  onData: (chunk: string) => void,
  session?: string,
) {
  return new Promise<IncomingMessage>((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(session ? { 'mcp-session-id': session } : {}),
      },
    })
    t.after(() => req.destroy())
    req.once('error', reject)
    req.once('response', (res) => {
      res.setEncoding('utf8').on('data', onData)
      res.on('error', () => {}) // The assertions report a lost stream.
      resolve(res)
    })
    req.end(JSON.stringify(body))
  })
}

const modes: Record<
  string,
  {
    args: string[]
    open: (t: TestContext, base: string) => Promise<Reader>
  }
> = {
  sse: {
    args: ['--outputTransport', 'sse'],
    async open(t, base) {
      const seen = collect()
      let endpoint = ''
      let buffer = ''
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(`${base}/sse`)
        t.after(() => req.destroy())
        req.once('error', reject).once('response', resolve).end()
      })
      res.setEncoding('utf8').on('data', (chunk: string) => {
        if (endpoint) return seen.sse(chunk)
        buffer += chunk
        const match = /event: endpoint\ndata: (.*)\n\n/.exec(buffer)
        if (!match) return
        endpoint = new URL(match[1], base).href
        seen.sse(buffer.slice(match.index + match[0].length))
      })
      while (!endpoint) await delay(10)
      const post = async (message: object) => {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(message),
          signal: AbortSignal.timeout(5000),
        })
        await response.text()
        assert.equal(response.status, 202)
      }
      await post(initialize(1))
      await post({ jsonrpc: '2.0', method: 'notifications/initialized' })
      await post(burst)
      return {
        pause: () => res.pause(),
        resume: () => res.resume(),
        ...seen,
      }
    },
  },
  ws: {
    args: ['--outputTransport', 'ws'],
    async open(t, base) {
      const seen = collect()
      const ws = new WebSocket(`${base.replace('http', 'ws')}/message`)
      t.after(() => ws.terminate())
      const replies: unknown[] = []
      ws.on('message', (data) => {
        const text = data.toString()
        if (JSON.parse(text).id === 1) replies.push(text)
        else seen.message(text)
      })
      await new Promise((resolve, reject) =>
        ws.once('open', resolve).once('error', reject),
      )
      ws.send(JSON.stringify(initialize(1)))
      while (!replies.length) await delay(10)
      ws.send(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      )
      ws.send(JSON.stringify(burst))
      return { pause: () => ws.pause(), resume: () => ws.resume(), ...seen }
    },
  },
  stateful: {
    args: ['--outputTransport', 'streamableHttp', '--stateful'],
    async open(t, base) {
      const seen = collect()
      const url = `${base}/mcp`
      const { response } = await rpc(url, initialize(1))
      const session = response.headers.get('mcp-session-id')!
      await rpc(
        url,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        session,
      )
      const res = await stream(t, url, burst, seen.sse, session)
      return {
        pause: () => res.pause(),
        resume: () => res.resume(),
        ...seen,
      }
    },
  },
  // The 2026-07-28 protocol: each request is its own HTTP exchange and child.
  modern: {
    args: ['--outputTransport', 'streamableHttp'],
    async open(t, base) {
      const seen = collect()
      const res = await new Promise<IncomingMessage>((resolve, reject) => {
        const req = request(`${base}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': '2026-07-28',
            'mcp-method': 'tools/call',
            'mcp-name': 'burst',
          },
        })
        t.after(() => req.destroy())
        req.once('error', reject).once('response', resolve)
        req.end(
          JSON.stringify({
            ...burst,
            params: {
              ...burst.params,
              _meta: {
                'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                'io.modelcontextprotocol/clientInfo': {
                  name: 'e2e',
                  version: '1',
                },
                'io.modelcontextprotocol/clientCapabilities': {},
              },
            },
          }),
        )
      })
      res.setEncoding('utf8').on('data', seen.sse)
      res.on('error', () => {})
      return {
        pause: () => res.pause(),
        resume: () => res.resume(),
        ...seen,
      }
    },
  },
  stateless: {
    args: ['--outputTransport', 'streamableHttp'],
    async open(t, base) {
      const seen = collect()
      const res = await stream(t, `${base}/mcp`, burst, seen.sse)
      return {
        pause: () => res.pause(),
        resume: () => res.resume(),
        ...seen,
      }
    },
  },
}

for (const [mode, { args, open }] of Object.entries(modes)) {
  test(
    `${mode}: a client that stops reading holds its own server's output until it reads again`,
    { timeout: gatewayTimeout(60000) },
    async (t) => {
      const control = await faultControl(t)
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        [
          '--stdio',
          'exec node tests/helpers/fault-peer.mjs',
          ...args,
          '--port',
          String(port),
          '--logLevel',
          'none',
        ],
        { FAULT_CONTROL: control.url },
      )
      const base = `http://127.0.0.1:${port}`
      while (true) {
        const up = await fetch(base, { signal: AbortSignal.timeout(250) })
          .then(() => true)
          .catch(() => false)
        if (up) break
        assert.equal(gateway.child.exitCode, null, gateway.errors())
        await delay(20)
      }

      const reader = await open(t, base)
      reader.pause()
      await control.wait('burst-start', undefined, 10000)
      await delay(HELD_FOR)
      assert.ok(
        !control.events.some((event) => event.kind === 'burst-done'),
        `the server finished writing ${COUNT} × 16 KiB while its client read ${reader.received()} of them: the gateway queued the rest`,
      )

      reader.resume()
      await control.wait('burst-done', undefined, 30000)
      const deadline = Date.now() + 30000
      while (!reader.answered() && Date.now() < deadline) await delay(10)
      assert.equal(reader.received(), COUNT)
      assert.ok(reader.answered(), 'the call is answered after the burst')
      assert.equal(gateway.child.exitCode, null, gateway.errors())
    },
  )
}
