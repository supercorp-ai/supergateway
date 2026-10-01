import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

// A JSON-RPC batch (protocol 2025-03-26) of any length is answered in full.
// From SDK 1.30.1 the Streamable HTTP transport refuses a batch of more than
// 100 messages with 400 -32600, with no option to change it, and the gateway
// cannot step around the check. Measured on the built gateway: 1.30.0
// answers 101 and 500 in full; 1.31.0 refuses both, stateless and stateful.
// This pins the current behaviour, so an SDK bump cannot change it unnoticed.
const LENGTH = 101

const batch = () =>
  Array.from({ length: LENGTH }, (_, index) => ({
    jsonrpc: '2.0',
    id: 1000 + index,
    method: 'tools/list',
  }))

const post = async (url: string, body: unknown, session?: string) => {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(requestTimeout(10000)),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const messages = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .flatMap((line) => JSON.parse(line.slice(5)))
  return { response, messages }
}

for (const stateful of [false, true]) {
  test(
    `${stateful ? 'stateful' : 'stateless'} HTTP answers a ${LENGTH}-message batch in full`,
    { timeout: gatewayTimeout(30000) },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        ...(stateful ? ['--stateful'] : []),
      ])
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      let session: string | undefined
      if (stateful) {
        const init = await post(url, initialize(1))
        assert.equal(init.response.status, 200)
        session = init.response.headers.get('mcp-session-id') ?? undefined
        assert.ok(session)
        await post(
          url,
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          session,
        )
      }
      const { response, messages } = await post(url, batch(), session)
      assert.equal(response.status, 200)
      const answered = new Set(
        messages
          .filter((message) => 'result' in message)
          .map((message) => message.id),
      )
      assert.equal(answered.size, LENGTH, 'every message in the batch')
    },
  )
}
