import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'

/**
 * Where a server-to-client notification is routed decides whether it arrives.
 *
 * `StreamableHTTPServerTransport.send` puts anything without a
 * `relatedRequestId` on the standalone GET stream, and when that stream is not
 * connected it returns silently — no throw, nothing for the gateway's `.catch`
 * to see, the notification simply gone. The client's GET stream is opened
 * asynchronously after initialize, so the window where it is missing is exactly
 * the start of a call: soak run 35410255256 lost `progress: 1` on macOS and
 * delivered 2 and 3, which had arrived 150ms and 300ms later.
 *
 * The stateful bridge already tracked its in-flight requests for shutdown
 * replies; it just never routed by them. The stateless bridge always has.
 */
test('a child notification rides the request in flight, and a reply routes by its own id', async (t) => {
  const b = observeGateway(t)
  const { stdioToStatefulStreamableHttp } = await import(
    '../src/gateways/stdioToStatefulStreamableHttp.js'
  )
  await stdioToStatefulStreamableHttp({
    stdioCmd: 'controlled-peer',
    port: 0,
    streamableHttpPath: '/mcp',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
    sessionTimeout: null,
    protocolVersion: '2024-11-05',
  })

  await b.request('POST', '/mcp', { body: initialize() })
  const transport = b.transports.at(-1)!
  const child = b.children.at(-1)!
  const reply = (message: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'))

  // Answer the handshake so it leaves the pending set; otherwise it stays in
  // flight forever and every notification routes through it.
  reply({ jsonrpc: '2.0', id: initialize().id, result: {} })

  // A call is now the only thing in flight, and the child emits progress before
  // it replies — the first notification of a call, which is the one that went
  // missing on macOS in soak run 35410255256.
  transport.onmessage({ jsonrpc: '2.0', id: 7, method: 'tools/call' })
  reply({
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 7, progress: 1, total: 3 },
  })

  const at = (predicate: (m: any) => boolean) =>
    transport.sent.findIndex(predicate)
  const progress = at((m: any) => m.method === 'notifications/progress')
  assert.ok(progress >= 0, 'the notification was forwarded at all')
  assert.equal(
    transport.sentOptions[progress]?.relatedRequestId,
    7,
    'it rides the stream of the call in flight, not the standalone GET stream',
  )

  // The reply leaves the pending set before it is sent, so there is no related
  // id to offer — and none is needed: the SDK routes a response by the id it
  // already carries.
  reply({ jsonrpc: '2.0', id: 7, result: { ok: true } })
  const answered = at((m: any) => m.id === 7 && m.result)
  assert.ok(answered >= 0, 'the reply was forwarded')
  assert.equal(transport.sentOptions[answered]?.relatedRequestId, undefined)
})
