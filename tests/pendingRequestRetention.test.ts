import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { queryObjects } from 'node:v8'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'

for (const mode of ['stateful', 'stateless'] as const) {
  test(`${mode} releases pending request IDs after child failure even if delivery or close rejects`, async (t) => {
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
    for (const failureStage of ['none', 'send', 'close']) {
      await b.request('POST', '/mcp', { body: initialize() })
      const child = b.children.at(-1)!
      const transport = b.transports.at(-1)!
      child.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n',
        ),
      )
      // Query live Sets after full GC, without holding references to them or
      // spying on clear(). A UUID distinguishes this request from unrelated
      // collections in the test runner. The positive control also guards
      // against a change in heap-summary visibility or formatting.
      const id = 'pending-retention-' + randomUUID()
      const retainers = () =>
        queryObjects(Set, { format: 'summary' }).filter((summary) =>
          summary.includes(id),
        )
      transport.onmessage!({
        jsonrpc: '2.0',
        id,
        method: 'tools/call',
        params: { name: 'hold' },
      })
      assert.equal(
        retainers().length,
        1,
        'the live request is retained before failure',
      )
      if (failureStage === 'send')
        t.mock.method(transport, 'send', async () => {
          throw new Error('send failed')
        })
      if (failureStage === 'close')
        t.mock.method(transport, 'close', async () => {
          throw new Error('close failed')
        })
      child.stdin.emit('error', new Error('child pipe failed'))
      await new Promise((resolve) => setImmediate(resolve))
      // b keeps the child and transport alive, including their callbacks.
      // Releasing the request data must not depend on those owners being GC'd.
      assert.equal(
        retainers().length,
        0,
        'failed request IDs must not remain in a retained collection',
      )
      assert.doesNotThrow(() => {
        child.emit('error', new Error('late child error'))
        child.stdin.emit('error', new Error('late stdin error'))
      }, 'late errors must remain handled after releasing request data')
    }
  })
}
