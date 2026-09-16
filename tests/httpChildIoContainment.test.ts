import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'

for (const mode of ['stateful', 'stateless'] as const) {
  test(`${mode} child failure cleanup tolerates repeated errors and a rejected close`, async (t) => {
    const b = observeGateway(t)
    const args = {
      stdioCmd: 'controlled-peer',
      port: 0,
      streamableHttpPath: '/mcp',
      logger: b.logger,
      corsOrigin: false,
      healthEndpoints: [],
      headers: {},
      sessionTimeout: 1000,
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
    for (const trigger of ['error', 'exit']) {
      for (const failureStage of ['none', 'send', 'close']) {
        const rejectClose = failureStage === 'close'
        const { res } = await b.request('POST', '/mcp', { body: initialize() })
        const child = b.children.at(-1)!
        const transport = b.transports.at(-1)!
        const session = transport.sessionId
        const failure = new Error(
          trigger === 'error'
            ? 'child pipe failed'
            : 'Child exited: code=17, signal=null',
        )
        const closeFailure = new Error('transport close failed')
        const sendFailure = new Error('transport send failed')
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }) + '\n',
          ),
        )
        for (const id of [0, 'pending'])
          transport.onmessage!({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name: 'hold' },
          })
        // Reverse-direction requests and replies have IDs too. Neither should
        // settle a pending client call or create a new pending client ID.
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'pending',
              method: 'roots/list',
            }) + '\n',
          ),
        )
        transport.onmessage!({ jsonrpc: '2.0', id: 'reverse', result: {} })
        if (failureStage === 'send')
          t.mock.method(transport, 'send', async () => {
            throw sendFailure
          })
        let closes = 0
        const close = transport.close.bind(transport)
        t.mock.method(transport, 'close', async () => {
          closes++
          if (rejectClose) throw closeFailure
          await close()
        })
        if (trigger === 'error') child.stdin.emit('error', failure)
        else child.emit('exit', 17, null)
        child.emit('error', new Error('subsequent child error'))
        child.stdin.emit('error', new Error('subsequent stdin error'))
        child.emit('exit', 1, null)
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(
          res.destroyed,
          true,
          'settle the initial response even before SDK registration',
        )
        assert.equal(
          child.kills,
          1,
          'attempt child termination exactly once, including close failure',
        )
        assert.equal(
          closes,
          1,
          'later error/exit events must not repeat transport closure',
        )
        assert.deepEqual(
          trigger === 'error'
            ? b.errors
                .filter(([message]) => message === 'Child process failure:')
                .at(-1)
            : b.errors.findLast(
                ([message]) => message === 'Child exited: code=17, signal=null',
              ),
          trigger === 'error'
            ? ['Child process failure:', failure]
            : ['Child exited: code=17, signal=null'],
        )
        if (failureStage === 'send') {
          assert.deepEqual(
            b.errors
              .filter(([message]) => message === 'Failed to send child failure')
              .slice(-2),
            [
              ['Failed to send child failure', sendFailure],
              ['Failed to send child failure', sendFailure],
            ],
          )
        } else {
          assert.deepEqual(
            transport.sent.filter((message) => 'error' in message),
            [0, 'pending'].map((id) => ({
              jsonrpc: '2.0',
              id,
              error: { code: -32603, message: 'MCP server process failed' },
            })),
          )
        }
        if (rejectClose)
          assert.deepEqual(
            b.errors.find(
              ([message]) =>
                message === 'Failed to close transport after child failure',
            ),
            ['Failed to close transport after child failure', closeFailure],
          )
        if (mode === 'stateful') {
          const rejected = await b.request('POST', '/mcp', {
            headers: { 'mcp-session-id': session },
            body: initialize(2),
          })
          assert.equal(
            rejected.res.code,
            400,
            'failed session is removed even if close rejects',
          )
        }
      }
    }
  })
}
