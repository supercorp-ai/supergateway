import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'
import { knownBugTest } from './helpers/known-bug.js'

// The `endpoint` event tells an SSE client where to POST its messages, and
// `--baseUrl` exists for when that is not the address the client connected to:
// a gateway behind a proxy or tunnel. So the only assertion that proves the
// option is honoured connects on one address and expects another.
//
// The version this replaces connected to `http://0.0.0.0:11000` and passed that
// same value as `--baseUrl`. A gateway that ignores the option sends a relative
// `/message?sessionId=…`, which resolves against the connection to exactly the
// URL it expected — so it passed against that mutant as well. Reading the raw
// event, rather than the SDK client's resolved URL, is what makes the two
// distinguishable. (The SDK client could not be used here anyway: it refuses an
// endpoint on a different origin from the stream it came from.)
const endpointEvent = async (t: TestContext, args: string[]) => {
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
  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await fetch(`http://127.0.0.1:${port}/sse`, {
    headers: { accept: 'text/event-stream' },
    signal: abort.signal,
  })
  assert.equal(response.status, 200)
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
  let received = ''
  while (!received.includes('\n\n')) {
    const { value, done } = await reader.read()
    if (done) break
    received += value
  }
  abort.abort()
  const event = received.split('\n\n')[0]
  assert.match(event, /^event: endpoint$/m, `not an endpoint event: ${event}`)
  return event.match(/^data: (.*)$/m)![1]
}

// Held as a known bug: #46. Since SDK 1.9, `SSEServerTransport` writes only
// `pathname + search + hash` into the endpoint event, so the scheme, host and
// port of `--baseUrl` are silently dropped and only its path survives. Clients
// that need an absolute endpoint, such as Microsoft Copilot Studio, cannot use
// the gateway. Restoring it is a behaviour change: the TypeScript and Python
// SDK clients reject an endpoint on another origin, so a `--baseUrl` that does
// not match how clients connect works today only because it is ignored.
knownBugTest(
  '#46',
  '--baseUrl sets the endpoint an SSE client is told to POST to',
  { timeout: 20000 },
  async (t) => {
    const data = await endpointEvent(t, [
      '--baseUrl',
      'https://public.example/gateway',
    ])
    assert.match(
      data,
      /^https:\/\/public\.example\/gateway\/message\?sessionId=[\w-]+$/,
    )
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
