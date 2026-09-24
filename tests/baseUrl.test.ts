import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

// The `endpoint` event tells an SSE client where to POST its messages, and
// `--baseUrl` exists for a gateway reached at some other address than its own:
// behind a proxy or a tunnel.
//
// An earlier version of this file connected to `http://0.0.0.0:11000` and passed
// that same value as `--baseUrl`, so a gateway that ignored the option sent a
// relative endpoint that resolved to exactly the URL it expected — it passed
// against that mutant, and hid #46 for over a year. Every case here reads the
// raw event and controls how the client appears to have connected, which is
// what the endpoint now depends on.
const endpointEvent = async (
  t: TestContext,
  args: string[],
  headers: Record<string, string> = {},
) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--outputTransport',
    'sse',
    '--port',
    String(port),
    '--ssePath',
    '/sse',
    '--messagePath',
    '/message',
    ...args,
  ])
  await gateway.ready()
  // `node:http` rather than fetch, which forbids setting Host.
  return new Promise<string>((resolve, reject) => {
    const req = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/sse',
        headers: { accept: 'text/event-stream', ...headers },
      },
      (res) => {
        assert.equal(res.statusCode, 200)
        let received = ''
        res.setEncoding('utf8').on('data', (chunk: string) => {
          received += chunk
          if (!received.includes('\n\n')) return
          req.destroy()
          const event = received.split('\n\n')[0]
          assert.match(event, /^event: endpoint$/m)
          resolve(event.match(/^data: (.*)$/m)![1])
        })
      },
    )
    req.on('error', (error) => {
      if (!req.destroyed) reject(error)
    })
    t.after(() => req.destroy())
  })
}

test(
  'a client that connected through --baseUrl is given it as an absolute endpoint',
  { timeout: 20000 },
  async (t) => {
    // #46: clients such as Microsoft Copilot Studio can only use an absolute
    // endpoint. Here a TLS-terminating proxy in front of the gateway keeps
    // the client's Host and says it arrived over https.
    const data = await endpointEvent(
      t,
      ['--baseUrl', 'https://pub.example/gateway'],
      { host: 'pub.example', 'x-forwarded-proto': 'https' },
    )
    assert.match(
      data,
      /^https:\/\/pub\.example\/gateway\/message\?sessionId=[\w-]+$/,
    )
  },
)

test(
  'a client that connected any other way keeps the relative endpoint',
  { timeout: 20000 },
  async (t) => {
    // The TypeScript and Python SDK clients reject an endpoint whose origin is
    // not the one they connected to. A client inside the network reaching the
    // gateway by its address must therefore not be sent `--baseUrl`'s host —
    // the relative endpoint resolves correctly for it, as it always has.
    const data = await endpointEvent(t, [
      '--baseUrl',
      'https://pub.example/gateway',
    ])
    assert.match(data, /^\/gateway\/message\?sessionId=[\w-]+$/)
  },
)

test(
  'without --baseUrl the endpoint is relative to the connection',
  { timeout: 20000 },
  async (t) => {
    const data = await endpointEvent(t, [])
    assert.match(data, /^\/message\?sessionId=[\w-]+$/)
  },
)
