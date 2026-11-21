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
import { sdkBetween } from './helpers/upstream.js'

// A JSON-RPC batch (protocol 2025-03-26) over Streamable HTTP.
//
// From SDK 1.30.1 the transport refuses a batch of more than 100 messages
// with 400 -32600 and runs none of it, with no option to change
// it. Up to 4.2.2 the gateway shipped SDK 1.30.0 and answered any length;
// from 4.2.3 it ships 1.32.2, so 100 is the most a batch may carry, as on
// every server built on the SDK since. The older SDKs in the CI matrix still
// answer 101 in full, and this says so, so the change cannot move unnoticed.
const LIMIT = 100
const capped = sdkBetween('1.30.1', '2.0.0')

const batch = (length: number) =>
  Array.from({ length }, (_, index) => ({
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
  return { response, text, messages }
}

const answeredIn = (messages: any[]) =>
  new Set(
    messages
      .filter((message) => 'result' in message)
      .map((message) => message.id),
  ).size

for (const stateful of [false, true]) {
  test(
    `${stateful ? 'stateful' : 'stateless'} HTTP answers a batch of up to ${LIMIT} messages in full, and ${capped ? 'refuses' : 'answers'} one more`,
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
      const full = await post(url, batch(LIMIT), session)
      assert.equal(full.response.status, 200)
      assert.equal(answeredIn(full.messages), LIMIT, 'every message in it')

      const over = await post(url, batch(LIMIT + 1), session)
      if (!capped) {
        assert.equal(over.response.status, 200)
        assert.equal(answeredIn(over.messages), LIMIT + 1)
        return
      }
      assert.equal(over.response.status, 400)
      assert.deepEqual(over.messages, [], 'nothing in it was answered')
      const refusal = JSON.parse(over.text)
      assert.equal(refusal.error.code, -32600, over.text)
      assert.equal(refusal.id, null)
      // The gateway, and the session, still serve.
      const after = await post(url, batch(1), session)
      assert.equal(answeredIn(after.messages), 1)
    },
  )
}
