import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'

for (const mode of ['stateful', 'stateless']) {
  test(`${mode} rejects new child work once shutdown begins`, async (t) => {
    const b = observeGateway(t)
    const args = {
      stdioCmd: 'peer',
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
    assert.equal(b.signals[0].drainStdin, true)
    await b.request('POST', '/mcp', { body: initialize() })
    await b.signals[0].cleanup()
    assert.equal(b.children[0].kills, 1)
    const rejected = await b.request('POST', '/mcp', { body: initialize(2) })
    assert.deepEqual(
      {
        code: rejected.res.code,
        body: rejected.res.body,
        children: b.children.length,
      },
      { code: 503, body: 'Gateway is shutting down', children: 1 },
    )
  })
}
