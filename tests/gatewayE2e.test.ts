import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer, request as httpRequest } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { WebSocket } from 'ws'
import {
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

const noisyPeerCommand = 'node tests/helpers/noisy-mcp-server.js stdio'

test(
  'stateful HTTP rejects malformed envelopes before and after initialization',
  { timeout: 20000 },
  async (t) => {
    const port = await unusedPort()
    const url = `http://127.0.0.1:${port}/mcp`
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '1000',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const invalidInit = await rpc(url, { ...initialize(), jsonrpc: 'invalid' })
    assert.equal(invalidInit.response.status, 400)
    assert.equal(invalidInit.messages[0].error.code, -32700)
    const healthyInit = await rpc(url, initialize(2))
    assert.equal(healthyInit.response.status, 200)
    const session = healthyInit.response.headers.get('mcp-session-id')!
    const invalidRequest = await rpc(url, { jsonrpc: '2.0', id: 3 }, session)
    assert.equal(invalidRequest.response.status, 400)
    assert.equal(invalidRequest.messages[0].error.code, -32700)
    const stale = await rpc(
      url,
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      session,
    )
    assert.equal(stale.response.status, 400)
    const recovered = await rpc(url, initialize(5))
    assert.equal(recovered.response.status, 200)
    assert.ok(recovered.response.headers.get('mcp-session-id'))
  },
)

// Assert protocol behavior through real CLI processes and sockets. No gateway
// internals or SDK methods are mocked, and every process/socket has teardown.
for (const [name, args, error] of [
  ['no input', [], /must specify one/],
  [
    'conflicting inputs',
    ['--stdio', peerCommand, '--sse', 'http://localhost/sse'],
    /Specify only one/,
  ],
  [
    'unsupported stdio output',
    ['--stdio', peerCommand, '--outputTransport', 'stdio'],
    /stdio→stdio not supported/,
  ],
  [
    'unsupported SSE output',
    ['--sse', 'http://localhost/sse', '--outputTransport', 'ws'],
    /sse→ws not supported/,
  ],
  [
    'unsupported HTTP output',
    ['--streamableHttp', 'http://localhost/mcp', '--outputTransport', 'sse'],
    /streamableHttp→sse not supported/,
  ],
  [
    'zero session timeout',
    [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '0',
    ],
    /must be a positive number/,
  ],
  [
    'negative session timeout',
    [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '-1',
    ],
    /must be a positive number/,
  ],
  ['invalid upstream URL', ['--streamableHttp', 'not-a-url'], /Fatal error/],
] as const) {
  test(`CLI rejects ${name}`, { timeout: 10000 }, async (t) => {
    const gateway = launchGateway(t, [...args])
    assert.equal((await gateway.exited).code, 1)
    assert.match(gateway.errors(), error)
  })
}

test(
  'CLI none logging suppresses diagnostics without changing failure status',
  { timeout: 10000 },
  async (t) => {
    const gateway = launchGateway(t, ['--logLevel', 'none'])
    assert.equal((await gateway.exited).code, 1)
    assert.equal(gateway.output(), '')
    assert.doesNotMatch(gateway.errors(), /\[supergateway\]/)
  },
)

for (const stateful of [true, false]) {
  test(
    `${stateful ? 'stateful' : 'stateless'} HTTP: health, headers, CORS and session validation`,
    { timeout: 20000 },
    async (t) => {
      const port = await unusedPort()
      const base = `http://127.0.0.1:${port}`
      const gateway = launchGateway(t, [
        '--stdio',
        noisyPeerCommand,
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        ...(stateful ? ['--stateful'] : []),
        '--healthEndpoint',
        '/health',
        '--cors',
        'https://allowed.example',
        '/trusted\\.example$/',
        '/[/',
        '--header',
        'X-Audit: value:with:colons',
        'invalid',
        ': missing',
        'Empty:',
        '--header',
        'Authorization: old',
        '--oauth2Bearer',
        'test-token',
        '--logLevel',
        'debug',
      ])
      await gateway.ready()
      const health = await fetch(base + '/health', {
        headers: { origin: 'https://allowed.example' },
      })
      assert.equal(health.status, 200)
      assert.equal(await health.text(), 'ok')
      assert.equal(health.headers.get('x-audit'), 'value:with:colons')
      assert.match(gateway.output(), /Headers: \{"X-Audit":"value:with:colons"/)
      assert.equal(health.headers.get('authorization'), 'Bearer test-token')
      assert.equal(
        health.headers.get('access-control-allow-origin'),
        'https://allowed.example',
      )
      assert.match(gateway.errors(), /Invalid header format/)
      for (const [origin, allowed] of [
        ['https://trusted.example', true],
        ['https://denied.example', false],
      ] as const) {
        const response = await fetch(base + '/health', { headers: { origin } })
        assert.equal(
          response.headers.get('access-control-allow-origin'),
          allowed ? origin : null,
        )
        await response.text()
      }
      for (const method of ['GET', 'DELETE']) {
        for (const session of [undefined, 'unknown-session']) {
          const response = await fetch(base + '/mcp', {
            method,
            headers: session ? { 'mcp-session-id': session } : {},
            signal: AbortSignal.timeout(5000),
          })
          assert.equal(response.status, stateful ? 400 : 405)
          assert.match(
            await response.text(),
            stateful ? /Invalid or missing session ID/ : /Method not allowed/,
          )
        }
      }
      if (stateful) {
        for (const session of [undefined, 'unknown-session']) {
          const bad = await rpc(
            base + '/mcp',
            { jsonrpc: '2.0', id: 2, method: 'tools/list' },
            session,
          )
          assert.equal(bad.response.status, 400)
          assert.equal(bad.messages[0].error.code, -32000)
        }
        const badInit = await rpc(
          base + '/mcp',
          initialize(),
          'unknown-session',
        )
        assert.equal(badInit.response.status, 400)
      }
      const init = await rpc(base + '/mcp', initialize())
      assert.equal(init.response.status, 200)
      assert.equal(init.messages[0].result.serverInfo.name, 'mock-server')
      const session = init.response.headers.get('mcp-session-id') ?? undefined
      assert.equal(Boolean(session), stateful)
      const tools = await rpc(
        base + '/mcp',
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        session,
      )
      assert.equal(tools.response.status, 200)
      assert.ok(
        tools.messages[0].result.tools.some(
          (tool: { name: string }) => tool.name === 'add',
        ),
      )
      await gateway.waitFor(
        () =>
          gateway
            .errors()
            .includes('Child non-JSON: peer startup diagnostic') &&
          gateway.errors().includes('Child stderr: peer stderr diagnostic'),
        'relay peer stdout/stderr diagnostics',
      )
      assert.match(gateway.errors(), /Child non-JSON: peer startup diagnostic/)
      assert.match(gateway.errors(), /Child stderr: peer stderr diagnostic/)
      if (stateful) {
        const ended = await fetch(base + '/mcp', {
          method: 'DELETE',
          headers: {
            'mcp-session-id': session!,
            accept: 'application/json, text/event-stream',
          },
        })
        assert.equal(ended.status, 200)
        await ended.text()
        const stale = await rpc(
          base + '/mcp',
          { jsonrpc: '2.0', id: 3, method: 'tools/list' },
          session,
        )
        assert.equal(stale.response.status, 400)
      }
    },
  )
}

test(
  'stateful HTTP expires idle sessions and accepts a fresh session afterward',
  { timeout: 20000 },
  async (t) => {
    const port = await unusedPort()
    const url = `http://127.0.0.1:${port}/mcp`
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '120',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const first = await rpc(url, initialize())
    const session = first.response.headers.get('mcp-session-id')!
    assert.ok(session)
    await gateway.waitFor(
      () => gateway.output().includes(`Session ${session} timed out`),
      'expire idle session',
    )
    const stale = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      session,
    )
    assert.equal(stale.response.status, 400)
    const fresh = await rpc(url, initialize(3))
    assert.equal(fresh.response.status, 200)
    assert.notEqual(fresh.response.headers.get('mcp-session-id'), session)
  },
)

test(
  'stateful HTTP keeps an active SSE session alive and cleans up after DELETE',
  { timeout: 20000 },
  async (t) => {
    const port = await unusedPort()
    const url = `http://127.0.0.1:${port}/mcp`
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '200',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const init = await rpc(url, initialize())
    const session = init.response.headers.get('mcp-session-id')!
    assert.ok(session)
    const stream = await fetch(url, {
      headers: { 'mcp-session-id': session, accept: 'text/event-stream' },
    })
    assert.equal(stream.status, 200)
    t.after(() => stream.body?.cancel())
    const tools = await rpc(
      url,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      session,
    )
    assert.equal(tools.response.status, 200)
    await delay(400)
    assert.doesNotMatch(
      gateway.output(),
      new RegExp(`Session ${session} timed out`),
    )
    const stillAlive = await rpc(
      url,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      session,
    )
    assert.equal(stillAlive.response.status, 200)
    await stream.body!.cancel()
    await gateway.waitFor(
      () => gateway.output().includes('GET response closed'),
      'observe stream closure',
    )
    const ended = await fetch(url, {
      method: 'DELETE',
      headers: {
        'mcp-session-id': session,
        accept: 'application/json, text/event-stream',
      },
    })
    assert.equal(ended.status, 200)
    await ended.text()
    const stale = await rpc(
      url,
      { jsonrpc: '2.0', id: 4, method: 'tools/list' },
      session,
    )
    assert.equal(stale.response.status, 400)
  },
)

for (const protocol of ['sse', 'streamableHttp'] as const) {
  for (const explicitClientInfo of [true, false]) {
    test(
      `${protocol} → stdio preserves results and errors with ${explicitClientInfo ? 'explicit' : 'default'} client metadata`,
      { timeout: 20000 },
      async (t) => {
        const port = await unusedPort()
        const upstream = launchGateway(t, [
          '--stdio',
          peerCommand,
          '--outputTransport',
          protocol,
          '--port',
          String(port),
          ...(protocol === 'streamableHttp' ? ['--stateful'] : []),
        ])
        await upstream.ready()
        const bridge = launchGateway(t, [
          `--${protocol}`,
          `http://127.0.0.1:${port}/${protocol === 'sse' ? 'sse' : 'mcp'}`,
          '--header',
          'X-Audit: bridge',
          '--logLevel',
          'debug',
        ])
        await bridge.ready()
        const request = async (message: {
          id: number
          [key: string]: unknown
        }) => {
          const find = () =>
            bridge
              .output()
              .split('\n')
              .slice(0, -1)
              .filter((line) => line.startsWith('{'))
              .map((line) => JSON.parse(line))
              .find((response) => response.id === message.id)
          bridge.child.stdin.write(JSON.stringify(message) + '\n')
          await bridge.waitFor(
            () => Boolean(find()),
            `reply to request ${message.id}`,
          )
          return find()
        }
        const init = await request(
          explicitClientInfo
            ? { ...initialize(), id: 1 }
            : { jsonrpc: '2.0', id: 1, method: 'initialize' },
        )
        assert.equal(init.result.serverInfo.name, 'mock-server')
        const reply = await request({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'add', arguments: { a: 2, b: 6 } },
        })
        assert.deepEqual(reply.result.content, [
          { type: 'text', text: 'The sum of 2 and 6 is 8.' },
        ])
        const unsupported = await request({
          jsonrpc: '2.0',
          id: 3,
          method: 'resources/list',
        })
        assert.equal(unsupported.error.code, -32601)
        assert.equal(unsupported.error.message, 'Method not found')
        const unknown = await request({
          jsonrpc: '2.0',
          id: 4,
          method: 'audit/unknown',
        })
        assert.equal(unknown.error.code, -32601)
        assert.equal(unknown.error.message, 'Method not found')
        assert.doesNotMatch(bridge.output(), /\[supergateway\]/)
        bridge.child.stdin.end()
        assert.equal((await bridge.exited).code, 0)
      },
    )
  }
  test(
    `${protocol} → stdio maps upstream HTTP failures and recovers on the next request`,
    { timeout: 20000 },
    async (t) => {
      const port = await unusedPort()
      const upstream = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        protocol,
        '--port',
        String(port),
        ...(protocol === 'streamableHttp' ? ['--stateful'] : []),
      ])
      await upstream.ready()
      let failPosts = false
      const seenHeaders: { authorization?: string; audit?: string }[] = []
      // Inject a real HTTP outage at the network boundary, not inside an SDK or
      // gateway function. All healthy traffic still reaches the real MCP peer.
      const proxy = createServer((req, res) => {
        seenHeaders.push({
          authorization: req.headers.authorization,
          audit: req.headers['x-audit'] as string,
        })
        if (failPosts && req.method === 'POST') {
          res.writeHead(503).end('upstream temporarily unavailable')
          return
        }
        const forwarded = httpRequest(
          `http://127.0.0.1:${port}${req.url}`,
          { method: req.method, headers: req.headers },
          (response) => {
            res.writeHead(response.statusCode!, response.headers)
            response.pipe(res)
          },
        )
        forwarded.on('error', () => {
          if (!res.headersSent) res.writeHead(502)
          res.end()
        })
        res.on('close', () => forwarded.destroy())
        req.pipe(forwarded)
      })
      t.after(async () => {
        proxy.closeAllConnections()
        await new Promise<void>((resolve) => proxy.close(() => resolve()))
      })
      await new Promise<void>((resolve) =>
        proxy.listen(0, '127.0.0.1', resolve),
      )
      const proxyPort = (proxy.address() as { port: number }).port
      const bridge = launchGateway(t, [
        `--${protocol}`,
        `http://127.0.0.1:${proxyPort}/${protocol === 'sse' ? 'sse' : 'mcp'}`,
        '--header',
        'X-Audit: network-boundary',
        '--header',
        'Authorization: old',
        '--oauth2Bearer',
        'test-token',
      ])
      await bridge.ready()
      const request = async (message: {
        id: number
        [key: string]: unknown
      }) => {
        const find = () =>
          bridge
            .output()
            .split('\n')
            .slice(0, -1)
            .filter((line) => line.startsWith('{'))
            .map((line) => JSON.parse(line))
            .find((response) => response.id === message.id)
        bridge.child.stdin.write(JSON.stringify(message) + '\n')
        await bridge.waitFor(
          () => Boolean(find()),
          `reply to request ${message.id}`,
        )
        return find()
      }
      assert.equal(
        (await request({ ...initialize(), id: 1 })).result.serverInfo.name,
        'mock-server',
      )
      assert.ok(seenHeaders.length > 0)
      assert.ok(
        seenHeaders.every(
          (headers) =>
            headers.authorization === 'Bearer test-token' &&
            headers.audit === 'network-boundary',
        ),
      )
      failPosts = true
      const failure = await request({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
      })
      assert.equal(failure.error.code, -32000)
      assert.match(
        failure.error.message,
        /HTTP 503.*upstream temporarily unavailable/,
      )
      failPosts = false
      const recovered = await request({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      })
      assert.ok(
        recovered.result.tools.some(
          (tool: { name: string }) => tool.name === 'add',
        ),
      )
    },
  )
}

test(
  'SSE CLI forwards MCP requests and rejects missing or closed sessions',
  { timeout: 20000 },
  async (t) => {
    const port = await unusedPort()
    const base = `http://127.0.0.1:${port}`
    const gateway = launchGateway(t, [
      '--stdio',
      noisyPeerCommand,
      '--port',
      String(port),
      '--healthEndpoint',
      '/health',
      '--cors',
      '--header',
      'X-Audit: yes',
    ])
    await gateway.ready()
    const health = await fetch(base + '/health', {
      headers: { origin: 'https://any.example' },
    })
    assert.equal(await health.text(), 'ok')
    assert.equal(health.headers.get('access-control-allow-origin'), '*')
    assert.equal(health.headers.get('x-audit'), 'yes')
    assert.match(gateway.output(), /Headers: \{"X-Audit":"yes"\}/)
    for (const [query, status, error] of [
      ['', 400, /Missing sessionId/],
      ['?sessionId=missing', 503, /No active SSE connection/],
    ] as const) {
      const response = await fetch(base + '/message' + query, {
        method: 'POST',
        body: '{}',
      })
      assert.equal(response.status, status)
      assert.match(await response.text(), error)
    }
    const client = new Client({ name: 'sse-e2e', version: '1' })
    t.after(() => client.close())
    await client.connect(new SSEClientTransport(new URL(base + '/sse')))
    const reply = await client.callTool({
      name: 'add',
      arguments: { a: 4, b: 5 },
    })
    assert.deepEqual(reply.content, [
      { type: 'text', text: 'The sum of 4 and 5 is 9.' },
    ])
    await gateway.waitFor(
      () =>
        gateway.errors().includes('Child non-JSON: peer startup diagnostic') &&
        gateway.errors().includes('Child stderr: peer stderr diagnostic'),
      'relay peer stdout/stderr diagnostics',
    )
    assert.match(gateway.errors(), /Child non-JSON: peer startup diagnostic/)
    assert.match(gateway.errors(), /Child stderr: peer stderr diagnostic/)
    await client.close()
  },
)

for (const withHealthAndCors of [true, false]) {
  test(
    `WebSocket CLI routes clients, broadcasts and late replies (${withHealthAndCors ? 'health/CORS enabled' : 'defaults'})`,
    { timeout: 20000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        noisyPeerCommand,
        '--outputTransport',
        'ws',
        '--port',
        String(port),
        ...(withHealthAndCors
          ? ['--healthEndpoint', '/health', '--cors', '*']
          : []),
        '--logLevel',
        'debug',
      ])
      await gateway.ready()
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { origin: 'https://any.example' },
      })
      assert.equal(health.status, withHealthAndCors ? 200 : 404)
      if (withHealthAndCors) assert.equal(await health.text(), 'ok')
      else await health.text()
      assert.equal(
        health.headers.get('access-control-allow-origin'),
        withHealthAndCors ? '*' : null,
      )
      const sockets = [
        new WebSocket(`ws://127.0.0.1:${port}/message`),
        new WebSocket(`ws://127.0.0.1:${port}/message`),
      ]
      t.after(() => {
        for (const socket of sockets) socket.terminate()
      })
      await Promise.all(sockets.map((socket) => once(socket, 'open')))
      const request = async (socket: WebSocket, message: object) => {
        const response = once(socket, 'message')
        socket.send(JSON.stringify(message))
        return JSON.parse(String((await response)[0]))
      }
      const initialized = await request(sockets[0], initialize())
      assert.equal(initialized.id, 1)
      assert.equal(initialized.result.serverInfo.name, 'mock-server')
      // The response socket, stdout and stderr are independent pipes: receiving
      // an RPC reply does not imply that diagnostics have reached the parent.
      await gateway.waitFor(
        () =>
          gateway
            .errors()
            .includes('Child non-JSON: peer startup diagnostic') &&
          gateway.output().includes('Child stderr: peer stderr diagnostic'),
        'relay peer stdout/stderr diagnostics',
      )
      assert.match(gateway.errors(), /Child non-JSON: peer startup diagnostic/)
      assert.match(gateway.output(), /Child stderr: peer stderr diagnostic/)
      sockets[0].send(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      )
      sockets[0].send('not-json')
      await gateway.waitFor(
        () => gateway.errors().includes('Failed to parse message'),
        'report malformed WebSocket JSON',
      )
      const results = await Promise.all(
        sockets.map((socket, index) =>
          request(socket, {
            jsonrpc: '2.0',
            id: 7,
            method: 'tools/call',
            params: { name: 'add', arguments: { a: index, b: 10 } },
          }),
        ),
      )
      for (const [index, result] of results.entries()) {
        assert.equal(result.id, 7)
        assert.equal(
          result.result.content[0].text,
          `The sum of ${index} and 10 is ${index + 10}.`,
        )
      }
      const delivered: any[][] = [[], []]
      for (const [index, socket] of sockets.entries()) {
        socket.on('message', (data) =>
          delivered[index].push(JSON.parse(String(data))),
        )
      }
      sockets[0].send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 9,
          method: 'tools/call',
          params: { name: 'announce', arguments: {} },
        }),
      )
      await gateway.waitFor(
        () =>
          delivered.every((messages) =>
            messages.some(
              (message) => message.method === 'notifications/message',
            ),
          ) && delivered[0].some((message) => message.id === 9),
        'broadcast the peer notification',
      )
      for (const messages of delivered) {
        assert.equal(
          messages.find((message) => message.method === 'notifications/message')
            .params.data,
          'hello subscribers',
        )
      }
      assert.equal(
        delivered[0].find((message) => message.id === 9).result.content[0].text,
        'announced',
      )
      assert.equal(delivered[1].filter((message) => message.id === 9).length, 0)
      sockets[0].send(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 10,
          method: 'tools/call',
          params: { name: 'delayed', arguments: {} },
        }),
      )
      await gateway.waitFor(
        () => gateway.output().includes('"name":"delayed"'),
        'forward delayed request',
      )
      const closed = once(sockets[0], 'close')
      sockets[0].close()
      await closed
      await gateway.waitFor(
        () => gateway.output().includes('"text":"delayed result"'),
        'receive the late reply after disconnect',
      )
      const alive = await request(sockets[1], {
        jsonrpc: '2.0',
        id: 8,
        method: 'tools/list',
      })
      assert.ok(
        alive.result.tools.some(
          (tool: { name: string }) => tool.name === 'add',
        ),
      )
      assert.equal(
        delivered[1].filter((message) => message.id === 10).length,
        0,
        'late reply must not leak to another client',
      )
      // Signal the CLI itself so it performs graceful child/socket cleanup.
      // The test's process-group cleanup is only a final safety net.
      for (const socket of sockets) socket.close()
      gateway.child.kill('SIGTERM')
      assert.equal((await gateway.exited).code, 0)
    },
  )
}

test(
  'WebSocket CLI reports invalid health route configuration and cleans up its child',
  { timeout: 10000 },
  async (t) => {
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'ws',
      '--healthEndpoint',
      '/[',
    ])
    assert.equal((await gateway.exited).code, 1)
    assert.match(gateway.errors(), /Failed to start/)
  },
)
