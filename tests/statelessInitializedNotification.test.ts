import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

// Stateless mode initializes each request's child itself, ending with its own
// notifications/initialized, then forwarded the client's copy too: the child
// received `initialized` twice, and a server that sets up on it did so twice.
test(
  'stateless HTTP delivers notifications/initialized to a child once',
  { timeout: 30000 },
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
    const post = async (message: object) => {
      const before = gateway.errors().length
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({ jsonrpc: '2.0', ...message }),
      })
      await response.text()
      // Give the child's stderr time to reach the gateway's log.
      await new Promise((resolve) => setTimeout(resolve, 500))
      const received = gateway
        .errors()
        .slice(before)
        .match(/RECEIVED [^\n]+/g)
      return { status: response.status, received: received ?? [] }
    }

    // map: the client's copy is not forwarded
    assert.deepEqual(await post({ method: 'notifications/initialized' }), {
      status: 202,
      received: [],
    })

    // map: any other notification still is, after the gateway's own handshake
    const other = await post({ method: 'notifications/roots/list_changed' })
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
    const asRequest = await post({ id: 7, method: 'notifications/initialized' })
    assert.equal(asRequest.status, 200)
    assert.equal(
      asRequest.received.filter((line) => line.includes('#7')).length,
      1,
    )
  },
)
