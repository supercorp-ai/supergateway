import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'
import { getVersion } from '../src/lib/getVersion.js'

for (const mode of ['stateful', 'stateless'] as const) {
  test(`${mode} HTTP gateway reports configuration, forwarding and transport lifecycle`, async (t) => {
    const b = observeGateway(t)
    const args = {
      stdioCmd: 'peer --http-test',
      port: 8132,
      streamableHttpPath: '/rpc',
      logger: b.logger,
      corsOrigin: ['https://allowed.example'],
      healthEndpoints: ['/health', '/ready'],
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
    // map: startup
    assert.deepEqual(b.info, [
      ['  - Headers: (none)'],
      ['  - port: 8132'],
      ['  - stdio: peer --http-test'],
      ['  - streamableHttpPath: /rpc'],
      ...(mode === 'stateless' ? [['  - protocolVersion: 2024-11-05']] : []),
      ['  - CORS: enabled (["https://allowed.example"])'],
      ['  - Health endpoints: /health, /ready'],
      ...(mode === 'stateful' ? [['  - Session timeout: disabled']] : []),
      ['Listening on port 8132'],
      ['StreamableHttp endpoint: http://localhost:8132/rpc'],
    ])
    // map: setup
    assert.deepEqual(
      {
        listens: b.listens,
        cors: b.corsOptions,
        routes: [...b.routes.keys()],
        signals: b.signals.map(({ logger }) => ({ logger })),
      },
      {
        listens: [8132],
        cors: [
          {
            origin: ['https://allowed.example'],
            ...(mode === 'stateful'
              ? { exposedHeaders: ['Mcp-Session-Id'] }
              : {}),
          },
        ],
        routes: [
          'GET /health',
          'GET /ready',
          'POST /rpc',
          'GET /rpc',
          'DELETE /rpc',
        ],
        signals: [{ logger: b.logger }],
      },
    )
    for (const path of ['/health', '/ready']) {
      const { res } = await b.request('GET', path)
      // map: health
      assert.deepEqual(
        { code: res.code, body: res.body },
        { code: 200, body: 'ok' },
      )
    }
    const input = initialize(31)
    const first = await b.request('POST', '/rpc', { body: input })
    const child = b.children[0],
      transport = b.transports[0]
    // map: request-setup
    assert.deepEqual(
      {
        spawns: b.spawns,
        servers: b.servers,
        connected: b.connections[0] === transport,
        body: transport.handled[0].body,
        response: transport.handled[0].res === first.res,
      },
      {
        spawns: [
          [
            'peer --http-test',
            { shell: true, detached: process.platform !== 'win32' },
          ],
        ],
        servers: [
          [
            { name: 'supergateway', version: getVersion() },
            { capabilities: {} },
          ],
        ],
        connected: true,
        body: input,
        response: true,
      },
    )
    // map: client-message
    assert.deepEqual(child.writes, [JSON.stringify(input) + '\n'])
    // map: client-diagnostics
    assert.deepEqual(
      b.info.slice(-1 * (mode === 'stateless' ? 2 : 1)),
      mode === 'stateless'
        ? [
            [`StreamableHttp → Child: ${JSON.stringify(input)}`],
            ['Tracking initialize request ID: 31'],
          ]
        : [[`StreamableHttp → Child: ${JSON.stringify(input)}`]],
    )
    const reply = {
      jsonrpc: '2.0',
      id: 31,
      result: { protocolVersion: '2024-11-05' },
    }
    child.stdout.emit(
      'data',
      Buffer.from('\n \n' + JSON.stringify(reply) + '\n'),
    )
    // map: reply
    assert.deepEqual(transport.sent, [reply])
    // map: reply-diagnostic
    assert.deepEqual(
      b.info.slice(mode === 'stateless' ? -2 : -1),
      mode === 'stateless'
        ? [
            ['Child → StreamableHttp:', JSON.stringify(reply)],
            ['Initialize response received'],
          ]
        : [['Child → StreamableHttp:', JSON.stringify(reply)]],
    )
    child.stdout.emit('data', Buffer.from('not-json\n'))
    child.stderr.emit('data', Buffer.from('upstream warning\n'))
    // map: parse-diagnostics
    assert.deepEqual(b.errors.slice(-2), [
      ['Child non-JSON: not-json'],
      ['Child stderr: upstream warning\n'],
    ])
    await transport.close()
    // map: close
    assert.deepEqual(
      // Check the event name only: the existing stateful diagnostic captures
      // the incoming session header, which is absent on initialization.
      {
        kills: child.kills,
        diagnostic: [b.info.at(-1)![0].split(' (session ')[0]],
      },
      { kills: 1, diagnostic: ['StreamableHttp connection closed'] },
    )
    const second = await b.request('POST', '/rpc', { body: initialize(32) })
    const failure = new Error('HTTP stream failed')
    b.transports[1].onerror!(failure)
    // map: error
    assert.deepEqual(
      {
        kills: b.children[1].kills,
        diagnostic: [
          b.errors.at(-1)![0].replace(/ \(session .*\):$/, ':'),
          b.errors.at(-1)![1],
        ],
      },
      { kills: 1, diagnostic: ['StreamableHttp error:', failure] },
    )
    if (mode === 'stateful') {
      for (const old of b.transports) {
        const missing = await b.request('GET', '/rpc', {
          headers: { 'mcp-session-id': old.sessionId },
        })
        // map: old-session
        assert.deepEqual(
          { code: missing.res.code, body: missing.res.body },
          { code: 400, body: 'Invalid or missing session ID' },
        )
      }
      first.res.emit('finish')
      second.res.emit('finish')
      await b.request('POST', '/rpc', { body: initialize(33) })
      b.children[2].emit('exit', 23, null)
      // map: stateful-child-exit
      assert.deepEqual(
        {
          closes: b.transports[2].closes,
          kills: b.children[2].kills,
          error: b.errors.at(-1),
        },
        { closes: 1, kills: 1, error: ['Child exited: code=23, signal=null'] },
      )
    } else {
      const third = await b.request('POST', '/rpc', {
        body: { jsonrpc: '2.0', id: 77, method: 'tools/list' },
      })
      const automatic = b.children[2],
        autoTransport = b.transports[2]
      const autoInit = JSON.parse(automatic.writes[0])
      // map: auto-initialize
      assert.deepEqual(autoInit, {
        ...initialize(autoInit.id),
        params: {
          protocolVersion: '2024-11-05',
          capabilities: { roots: { listChanged: true }, sampling: {} },
          clientInfo: { name: 'supergateway', version: getVersion() },
        },
      })
      automatic.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ jsonrpc: '2.0', id: autoInit.id, result: {} }) +
            '\n',
        ),
      )
      // map: auto-release
      assert.deepEqual(
        automatic.writes.slice(1).map((s) => JSON.parse(s)),
        [
          { jsonrpc: '2.0', method: 'notifications/initialized' },
          third.req.body,
        ],
      )
      // map: auto-hidden
      assert.deepEqual(autoTransport.sent, [])
      // map: auto-diagnostics
      assert.deepEqual(b.info.slice(-7), [
        [`StreamableHttp → Child: ${JSON.stringify(third.req.body)}`],
        [
          'Non-initialize message detected, sending auto-initialize request first',
        ],
        [
          `StreamableHttp → Child (auto-initialize): ${JSON.stringify(autoInit)}`,
        ],
        [
          'Child → StreamableHttp:',
          JSON.stringify({ jsonrpc: '2.0', id: autoInit.id, result: {} }),
        ],
        ['Initialize response received'],
        [
          'StreamableHttp → Child (initialized): {"jsonrpc":"2.0","method":"notifications/initialized"}',
        ],
        [
          `StreamableHttp → Child (original): ${JSON.stringify(third.req.body)}`,
        ],
      ])
      // A later peer reply reusing the internal ID must be forwarded, not
      // mistaken for another initialization response or replay the request.
      automatic.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({
            jsonrpc: '2.0',
            id: autoInit.id,
            result: { marker: 'later' },
          }) + '\n',
        ),
      )
      // map: auto-reset
      assert.deepEqual(
        { writes: automatic.writes.length, replies: autoTransport.sent },
        {
          writes: 3,
          replies: [
            { jsonrpc: '2.0', id: autoInit.id, result: { marker: 'later' } },
          ],
        },
      )
      automatic.emit('exit', 23, null)
      // map: child-exit
      assert.deepEqual(
        {
          closes: autoTransport.closes,
          kills: automatic.kills,
          error: b.errors.at(-1),
        },
        { closes: 1, kills: 1, error: ['Child exited: code=23, signal=null'] },
      )
      for (const method of ['GET', 'DELETE']) {
        const rejected = await b.request(method, '/rpc')
        // map: unsupported-method
        assert.deepEqual(
          {
            code: rejected.res.code,
            body: JSON.parse(rejected.res.body),
            log: b.info.at(-1),
          },
          {
            code: 405,
            body: {
              jsonrpc: '2.0',
              error: { code: -32000, message: 'Method not allowed.' },
              id: null,
            },
            log: [`Received ${method} MCP request`],
          },
        )
      }
    }
  })
}
