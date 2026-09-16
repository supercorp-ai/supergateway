import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

const rejection = (id: string | number) => ({
  jsonrpc: '2.0',
  id,
  error: {
    code: -32601,
    message: 'Server-to-client requests are not supported in stateless mode',
  },
})
const advertised = {
  roots: { listChanged: true },
  sampling: {},
  elicitation: {},
  experimental: { custom: {} },
}

for (const direct of [true, false]) {
  test(
    `stateless ${direct ? 'direct' : 'automatic'} initialization: notification routing, reverse IDs and capability limits on the wire`,
    { timeout: 30000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        'node tests/helpers/stateless-reverse-peer.mjs',
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
      ])
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      // Concurrent children reuse IDs across both directions, including falsy IDs.
      await Promise.all(
        [0, '', 'client-id', 'ping-id'].map(async (id, index) => {
          const message = direct
            ? {
                ...initialize(id),
                params: { ...initialize(id).params, capabilities: advertised },
              }
            : {
                jsonrpc: '2.0',
                id,
                method: 'tools/call',
                params: {
                  name: 'reverse',
                  arguments: {
                    method: [
                      'sampling/createMessage',
                      'roots/list',
                      'elicitation/create',
                      'ping',
                    ][index],
                  },
                },
              }
          const { response, messages } = await rpc(url, message)
          assert.equal(response.status, 200)
          // Auto-initialize itself emits a notification too, on the original call's stream.
          const notifications = messages.slice(0, -1)
          assert.equal(notifications.length, direct ? 1 : 2)
          assert.ok(
            notifications.every((n) => n.method === 'notifications/message'),
          )
          assert.deepEqual(notifications.at(-1).params.data, {
            requestId: id,
            capabilities: {},
          })
          const final = messages.at(-1)
          assert.equal(final.id, id)
          assert.equal(final.jsonrpc, '2.0')
          const observed = JSON.parse(
            direct ? final.result.instructions : final.result.content[0].text,
          )
          assert.deepEqual(observed, {
            capabilities: {},
            reply:
              !direct && id === 'ping-id'
                ? { jsonrpc: '2.0', id, result: {} }
                : rejection(id),
          })
          assert.ok(
            messages.every((n) => !('method' in n && 'id' in n)),
            'reverse requests must not escape to another HTTP child',
          )
        }),
      )
    },
  )
}

test('stateless reverse requests preserve pending calls, reject before init matching, and do not forward replies', async (t) => {
  const b = observeGateway(t)
  const { stdioToStatelessStreamableHttp } = await import(
    '../src/gateways/stdioToStatelessStreamableHttp.js'
  )
  await stdioToStatelessStreamableHttp({
    stdioCmd: 'controlled',
    port: 0,
    streamableHttpPath: '/mcp',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
    protocolVersion: '2024-11-05',
  })
  const original = {
    ...initialize('client'),
    params: { ...initialize('client').params, capabilities: advertised },
  }
  await b.request('POST', '/mcp', { body: original })
  assert.deepEqual(JSON.parse(b.children[0].writes[0]), {
    ...original,
    params: { ...original.params, capabilities: {} },
  })
  assert.deepEqual(
    original.params.capabilities,
    advertised,
    'do not mutate the incoming message',
  )
  const child = b.children[0],
    transport = b.transports[0]
  const deliveries: any[] = []
  t.mock.method(
    transport,
    'send',
    async (message: unknown, options: unknown) => {
      deliveries.push({ message, options })
    },
  )
  const emit = (message: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'))
  for (const id of ['client', 0, '']) {
    emit({ jsonrpc: '2.0', id, method: 'roots/list' })
    assert.deepEqual(JSON.parse(child.writes.at(-1)!), rejection(id))
  }
  assert.deepEqual(
    deliveries,
    [],
    'reverse requests, including the initialize ID collision, never go to HTTP',
  )
  const notice = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: 'before' },
  }
  emit(notice)
  assert.deepEqual(deliveries, [
    { message: notice, options: { relatedRequestId: 'client' } },
  ])
  child.emit('exit', 1, null)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(
    deliveries.at(-1).message,
    {
      jsonrpc: '2.0',
      id: 'client',
      error: { code: -32603, message: 'MCP server process failed' },
    },
    'rejecting a reverse ID collision must not remove the pending client call',
  )

  // Notification-only input has no HTTP response stream. Reverse requests must
  // still receive errors locally without creating a phantom client request.
  await b.request('POST', '/mcp', {
    body: { jsonrpc: '2.0', method: 'notifications/initialized' },
  })
  const oneWay = b.children[1]
  const init = JSON.parse(oneWay.writes[0])
  assert.deepEqual(init.params.capabilities, {})
  oneWay.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: init.id, result: {} }) + '\n',
    ),
  )
  oneWay.stdout.emit(
    'data',
    Buffer.from(
      JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }) + '\n',
    ),
  )
  assert.deepEqual(JSON.parse(oneWay.writes.at(-1)!), {
    jsonrpc: '2.0',
    id: 0,
    result: {},
  })
  assert.deepEqual(b.transports[1].sent, [])
})
