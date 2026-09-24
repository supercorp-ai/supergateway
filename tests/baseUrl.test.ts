import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

// What `--baseUrl` does in stdio→SSE mode: it sets the *path* of the endpoint
// an SSE client is told to POST to, and nothing else.
//
// `SSEServerTransport` documents its endpoint as "the relative or absolute URL"
// to send clients to, and up to SDK 1.9.0 it sent a full `--baseUrl` verbatim.
// SDK 1.10.0 (typescript-sdk#177, a fix for sessionId query handling) began
// writing only `pathname + search + hash`, so the scheme, host and port have
// not reached any client since — #46. We decided not to restore them: after that
// long, some Python and Java clients depend on the relative endpoint (they
// compare the endpoint's port literally, and `Host` loses an explicit `:443`),
// and the one client reported as needing an absolute endpoint, Copilot Studio,
// now only speaks Streamable HTTP. See #227 for the evidence.
//
// So these pin the behaviour deliberately. If an SDK release restores the host,
// the second test fails, and the decision gets made again rather than shipped
// by accident.
//
// An earlier version of this file connected to the same address it passed as
// `--baseUrl`, so a relative endpoint resolved to exactly the URL it expected
// and it could not tell the host being sent from the host being dropped. Every
// case here reads the raw event and controls how the client appears to connect.
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
  "--baseUrl's path prefixes the endpoint",
  { timeout: 20000 },
  async (t) => {
    // The part of `--baseUrl` that does take effect: behind a proxy that
    // serves the gateway under `/gateway`, clients POST to the right place.
    const data = await endpointEvent(t, [
      '--baseUrl',
      'https://pub.example/gateway',
    ])
    assert.match(data, /^\/gateway\/message\?sessionId=[\w-]+$/)
  },
)

test(
  "--baseUrl's host is not sent, even to a client that connected through it",
  { timeout: 20000 },
  async (t) => {
    // The strongest case for sending it — a proxy keeping the client's Host
    // and saying it arrived over https — still gets a path. Fails if an SDK
    // release restores the documented absolute endpoint.
    const data = await endpointEvent(
      t,
      ['--baseUrl', 'https://pub.example/gateway'],
      { host: 'pub.example', 'x-forwarded-proto': 'https' },
    )
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
