import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'

for (const mode of ['stateful', 'stateless'] as const) {
  test(`${mode} child exit waits for every error delivery before closing and ignores later failure events`, async (t) => {
    const b = observeGateway(t)
    const args = {
      stdioCmd: 'controlled-peer',
      port: 0,
      streamableHttpPath: '/mcp',
      logger: b.logger,
      corsOrigin: false,
      healthEndpoints: [],
      headers: {},
      sessionTimeout: null,
      protocolVersion: '2024-11-05',
    }
    if (mode === 'stateful') {
      const { stdioToStatefulStreamableHttp } = await import(
        '../src/gateways/stdioToStatefulStreamableHttp.js'
      )
      await stdioToStatefulStreamableHttp(args)
    } else {
      const { stdioToStatelessStreamableHttp } = await import(
        '../src/gateways/stdioToStatelessStreamableHttp.js'
      )
      await stdioToStatelessStreamableHttp(args)
    }
    const { res } = await b.request('POST', '/mcp', { body: initialize(1) })
    const child = b.children[0]
    const transport = b.transports[0]
    child.stdout.emit(
      'data',
      Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'),
    )
    for (const id of [0, 'pending'])
      transport.onmessage!({ jsonrpc: '2.0', id, method: 'tools/list' })
    const deliveries: { message: any; finish: () => void }[] = []
    t.mock.method(
      transport,
      'send',
      (message: any) =>
        new Promise<void>((resolve) => {
          deliveries.push({ message, finish: resolve })
        }),
    )
    child.emit('exit', 17, null)
    child.emit('error', new Error('late child error'))
    child.stdin.emit('error', new Error('late pipe error'))
    child.emit('exit', 17, null)
    assert.deepEqual(
      deliveries.map((d) => d.message),
      [0, 'pending'].map((id) => ({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: 'MCP server process failed' },
      })),
      'fail each unfinished client ID once, excluding the completed initialize',
    )
    assert.equal(
      transport.closes,
      0,
      'keep HTTP open until error frames settle',
    )
    assert.equal(
      res.destroyed,
      false,
      'do not destroy the response while error delivery is pending',
    )
    deliveries[0].finish()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      transport.closes,
      0,
      'one delivered error does not allow closing another pending response',
    )
    deliveries[1].finish()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(
      transport.closes,
      1,
      'close exactly once after both deliveries',
    )
    assert.equal(
      res.destroyed,
      true,
      'unfinished HTTP response is released after error delivery',
    )
  })
}
