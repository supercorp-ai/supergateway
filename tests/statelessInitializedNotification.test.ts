import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

// Stateless mode initializes each request's child itself, ending with its own
// notifications/initialized, then forwarded the client's copy too: the child
// received `initialized` twice, and a server that sets up on it did so twice.
test(
  'stateless HTTP delivers notifications/initialized to a child once',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/recording-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    // `expected` is how many lines the child should log. They reach the
    // gateway's log through the child's stderr, so wait for that many rather
    // than a fixed half second (a loaded soak runner took longer), then allow
    // the same again for any extra line that would fail the assertion.
    const post = async (message: object, expected: number) => {
      const before = gateway.errors().length
      const lines = () =>
        gateway
          .errors()
          .slice(before)
          .match(/RECEIVED [^\n]+/g) ?? []
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(requestTimeout(5000)),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      })
      await response.text()
      if (expected)
        await gateway.waitFor(
          () => lines().length >= expected,
          `child logs ${expected} line(s)`,
        )
      await new Promise((resolve) => setTimeout(resolve, requestTimeout(500)))
      return { status: response.status, received: lines() }
    }

    // map: the client's copy is not forwarded
    assert.deepEqual(await post({ method: 'notifications/initialized' }, 0), {
      status: 202,
      received: [],
    })

    // map: any other notification still is, after the gateway's own handshake
    const other = await post({ method: 'notifications/roots/list_changed' }, 3)
    assert.equal(other.status, 202)
    assert.deepEqual(
      other.received.map((line) => line.replace(/#init_\S+/, '#init')),
      [
        'RECEIVED initialize #init',
        'RECEIVED notifications/initialized',
        'RECEIVED notifications/roots/list_changed',
      ],
    )

    // map: one carrying an id is a request, and gets its answer
    const asRequest = await post(
      { id: 7, method: 'notifications/initialized' },
      3,
    )
    assert.equal(asRequest.status, 200)
    assert.equal(
      asRequest.received.filter((line) => line.includes('#7')).length,
      1,
    )
  },
)
