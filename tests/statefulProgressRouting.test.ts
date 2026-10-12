import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'

// A stateful session routes a server's progress to the request that asked
// for it, by its token (see statefulNotificationRouting.test.ts for why any
// notification has to ride a request). In a file of its own: the observed
// gateway is one per file.

test('a progress token is forgotten with its request: late progress for it rides whatever is in flight', async (t) => {
  const b = observeGateway(t)
  const { stdioToStatefulStreamableHttp } =
    await import('../src/gateways/stdioToStatefulStreamableHttp.js')
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
  reply({ jsonrpc: '2.0', id: initialize().id, result: {} })

  // Two calls in flight: the second asked for progress under a token.
  transport.onmessage({ jsonrpc: '2.0', id: 7, method: 'tools/call' })
  transport.onmessage({
    jsonrpc: '2.0',
    id: 8,
    method: 'tools/call',
    params: { _meta: { progressToken: 'p' } },
  })
  const progress = (n: number) =>
    reply({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'p', progress: n },
    })
  const routeOf = (n: number) =>
    transport.sentOptions[
      transport.sent.findIndex((m: any) => m.params?.progress === n)
    ]?.relatedRequestId
  progress(1)
  assert.equal(routeOf(1), 8, 'its own request, not the first in flight')
  // That request is answered. The stream it had is gone, so progress still
  // sent under its token goes with the call that is left.
  reply({ jsonrpc: '2.0', id: 8, result: {} })
  progress(2)
  assert.equal(routeOf(2), 7)
})
