import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

// The stateless Streamable HTTP gateway, end to end against the built CLI:
// what a client's own notifications/initialized leaves in the operator's log,
// the SSE wire bytes of a reply carrying U+2028/U+2029, and a server
// notification sent while the gateway's own initialize is still unanswered.

const prefix = '[supergateway] '
const options = { timeout: gatewayTimeout(20000) }

const start = async (t: TestContext, command: string) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    command,
    '--outputTransport',
    'streamableHttp',
    '--port',
    String(port),
  ])
  await gateway.ready()
  return { gateway, url: `http://127.0.0.1:${port}/mcp` }
}

// The raw response: the questions here are about bytes and events on the
// wire, which a client SDK would already have framed away.
const post = async (url: string, message: object) => {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(requestTimeout(10000)),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(message),
  })
  return { status: response.status, raw: await response.text() }
}

// SSE splits on CRLF, CR or LF, and nothing else.
const events = (raw: string) =>
  raw
    .split(/\r\n|\r|\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => JSON.parse(line.slice(5)))

test(
  "stateless HTTP accepts a client's notifications/initialized and tells the operator the child was initialized by the gateway",
  options,
  async (t) => {
    const { gateway, url } = await start(
      t,
      'node tests/helpers/mock-mcp-server.js stdio',
    )
    const { status } = await post(url, {
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    })
    // map: notification-accepted
    assert.equal(status, 202)
    const line = `${prefix}Client initialized; this child was initialized here`
    await gateway.waitFor(
      () => gateway.output().includes(line),
      'log that the client initialized notification was not forwarded',
    )
    // map: notification-not-forwarded
    assert.equal(
      gateway.output().includes('notifications/initialized'),
      false,
      'the client copy is neither forwarded nor logged as forwarded',
    )
  },
)

test(
  'stateless HTTP escapes U+2028/U+2029 in its SSE reply without changing their JSON value',
  options,
  async (t) => {
    const { url } = await start(t, 'node tests/clients/battery-peer.mjs')
    const separators = 'before middle after'
    // No initialize first: the gateway initializes this request's child.
    const { status, raw } = await post(url, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'separators', arguments: {} },
    })
    assert.equal(status, 200)
    const bytes = Buffer.from(raw, 'utf8')
    // map: separators-escaped
    assert.deepEqual(
      {
        u2028: bytes.includes(Buffer.from([0xe2, 0x80, 0xa8])),
        u2029: bytes.includes(Buffer.from([0xe2, 0x80, 0xa9])),
        escaped: raw.includes('\\u2028') && raw.includes('\\u2029'),
      },
      { u2028: false, u2029: false, escaped: true },
    )
    // map: separators-value
    assert.deepEqual(
      events(raw).map((message) => message.result?.content),
      [[{ type: 'text', text: separators }]],
    )
  },
)

test(
  "stateless HTTP relays a server's notification sent before it answers the gateway's initialize",
  options,
  async (t) => {
    // This peer sends notifications/message ahead of every initialize reply.
    const { gateway, url } = await start(
      t,
      'node tests/helpers/interleaving-mcp-peer.mjs',
    )
    const { status, raw } = await post(url, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    })
    assert.equal(status, 200)
    // map: early-notification
    assert.deepEqual(events(raw), [
      {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'info', data: 'initializing' },
      },
      { jsonrpc: '2.0', id: 3, result: { tools: [] } },
    ])
    // map: handshake-once
    assert.equal(
      gateway
        .output()
        .split('\n')
        .filter((line) => line === `${prefix}Initialize response received`)
        .length,
      1,
    )
    // map: no-stray-reply
    assert.equal(gateway.errors().includes('Failed to send'), false)
  },
)
