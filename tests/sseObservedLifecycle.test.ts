import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway, Response } from './helpers/observed-gateway.js'
import { getVersion } from '../src/lib/getVersion.js'

test('SSE gateway preserves routing, reports peer events and removes ended sessions', async (t) => {
  const b = observeGateway(t)
  const { stdioToSse } = await import('../src/gateways/stdioToSse.js')
  await stdioToSse({
    stdioCmd: 'peer --sse-test',
    port: 8127,
    baseUrl: 'https://proxy.example/prefix',
    ssePath: '/events',
    messagePath: '/messages',
    logger: b.logger,
    corsOrigin: ['https://client.example', /trusted$/],
    healthEndpoints: ['/health', '/ready'],
    headers: {},
  })
  // map: startup
  assert.deepEqual(b.info, [
    ['  - Headers: (none)'],
    ['  - port: 8127'],
    ['  - stdio: peer --sse-test'],
    ['  - baseUrl: https://proxy.example/prefix'],
    ['  - ssePath: /events'],
    ['  - messagePath: /messages'],
    ['  - CORS: enabled (["https://client.example","/trusted$/"])'],
    ['  - Health endpoints: /health, /ready'],
    ['Listening on port 8127'],
    ['SSE endpoint: http://localhost:8127/events'],
    ['POST messages: http://localhost:8127/messages'],
  ])
  // map: setup
  assert.deepEqual(
    {
      spawns: b.spawns,
      listens: b.listens,
      cors: b.corsOptions,
      routes: [...b.routes.keys()],
      // No `Server` exists until a client connects: there is one per session,
      // not one per process. A shared one served a single connection for the
      // lifetime of the gateway and crashed on the second (#112, #138, #153).
      servers: b.servers,
    },
    {
      spawns: [],
      listens: [8127],
      cors: [{ origin: ['https://client.example', /trusted$/] }],
      routes: ['GET /health', 'GET /ready', 'GET /events', 'POST /messages'],
      servers: [],
    },
  )
  // map: signals
  assert.deepEqual(
    b.signals.map(({ logger, drainStdin }) => ({ logger, drainStdin })),
    [{ logger: b.logger, drainStdin: true }],
  )
  let next = 0
  b.middleware[2]({ path: '/messages' }, new Response(), () => next++)
  // map: raw-body
  assert.deepEqual({ parses: b.parses(), next }, { parses: 0, next: 1 })
  b.middleware[2]({ path: '/other' }, new Response(), () => next++)
  // map: json-body
  assert.deepEqual({ parses: b.parses(), next }, { parses: 1, next: 2 })
  for (const path of ['/health', '/ready']) {
    const { res } = await b.request('GET', path)
    // map: health
    assert.deepEqual(
      { code: res.code, body: res.body },
      { code: 200, body: 'ok' },
    )
  }
  for (const [index, ending] of (
    ['close', 'request-close'] as const
  ).entries()) {
    const { req } = await b.request('GET', '/events')
    const transport = b.transports.at(-1)!
    const id = transport.sessionId!
    const child = b.children[index]
    assert.deepEqual(b.spawns[index], [
      'peer --sse-test',
      { shell: true, detached: process.platform !== 'win32' },
    ])
    // map: session-server
    assert.deepEqual(
      { count: b.servers.length, args: b.servers.at(-1) },
      {
        count: index + 1,
        args: [
          { name: 'supergateway', version: getVersion() },
          { capabilities: {} },
        ],
      },
    )
    // map: transport-binding
    assert.equal(b.connections.at(-1), transport)
    // map: transport-url
    assert.equal(transport.options, 'https://proxy.example/prefix/messages')
    const message = { jsonrpc: '2.0', id: 7, method: 'ping' }
    const accepted = await b.request('POST', '/messages', {
      query: { sessionId: id },
      body: message,
    })
    // map: post-accepted
    assert.equal(accepted.res.code, 202)
    // map: child-message
    assert.equal(child.writes.at(-1), JSON.stringify(message) + '\n')
    const reply = { jsonrpc: '2.0', id: 7, result: {} }
    child.stdout.emit(
      'data',
      Buffer.from('\n  \n' + JSON.stringify(reply) + '\n'),
    )
    // map: peer-reply
    assert.deepEqual(transport.sent, [reply])
    if (ending === 'close') await transport.close()
    else req.emit('close')
    const rejected = await b.request('POST', '/messages', {
      query: { sessionId: id },
      body: message,
    })
    // map: removed-session
    assert.deepEqual(
      { code: rejected.res.code, body: rejected.res.body },
      { code: 503, body: `No active SSE connection for session ${id}` },
    )
    // map: session-server-closed
    //
    // Exactly one close per ending, and exactly one diagnostic. Closing a
    // session's `Server` closes its transport, which fires `onclose`, which
    // arrives back at the same teardown — so a handler that acted before
    // removing the session would recurse until the stack ran out
    // (@RussellZager, on #113) and would log its ending twice on the way.
    assert.equal(b.serverCloses.length, index + 1)
    assert.equal(child.kills, 1, 'closing a session terminates only its child')
    const endings: number = (b.info as unknown[][]).filter(
      (line: unknown[]) =>
        line[0] === `SSE connection closed (session ${id})` ||
        line[0] === `Client disconnected (session ${id})`,
    ).length
    assert.equal(endings, 1)
    // map: session-diagnostic
    assert.deepEqual(b.info.at(-1), [
      ending === 'close'
        ? `SSE connection closed (session ${id})`
        : `Client disconnected (session ${id})`,
    ])
    // map: connection-diagnostics
    assert.deepEqual(b.info.slice(-5, -1), [
      [`New SSE connection from 127.0.0.9`],
      [`POST to SSE transport (session ${id})`],
      [`SSE → Child (session ${id}): ${JSON.stringify(message)}`],
      [`Child → SSE (session ${id}):`, reply],
    ])
  }
  const { req: recoverableReq } = await b.request('GET', '/events')
  const recoverable = b.transports.at(-1)!
  const recoverableId = recoverable.sessionId!
  const closesBeforeError = b.serverCloses.length
  const requestError = new Error('invalid POST body')
  recoverable.onerror!(requestError)
  assert.deepEqual(b.errors.at(-1), [
    `SSE error (session ${recoverableId}):`,
    requestError,
  ])
  assert.equal(b.serverCloses.length, closesBeforeError)
  const followup = await b.request('POST', '/messages', {
    query: { sessionId: recoverableId },
    body: { jsonrpc: '2.0', id: 8, method: 'ping' },
  })
  assert.equal(
    followup.res.code,
    202,
    'a rejected POST leaves its session usable',
  )
  recoverableReq.emit('close')
  const recoveredChild = b.children.at(-1)!
  recoveredChild.stdout.emit('data', Buffer.from('broken-json\n'))
  recoveredChild.stderr.emit('data', Buffer.from('peer diagnostic\n'))
  // map: peer-diagnostics
  assert.deepEqual(b.errors.slice(-2), [
    [`Child non-JSON (session ${recoverableId}): broken-json`],
    [`Child stderr (session ${recoverableId}): peer diagnostic\n`],
  ])
  const active = await b.request('GET', '/events')
  const activeId = b.transports.at(-1)!.sessionId!
  const exitedChild = b.children.at(-1)!
  exitedChild.emit('exit', 17, null)
  assert.deepEqual(b.errors.at(-1), [
    `Child exited (session ${activeId}): code=17, signal=null`,
  ])
  const rejectedAfterExit = await b.request('POST', '/messages', {
    query: { sessionId: activeId },
    body: { jsonrpc: '2.0', id: 9, method: 'ping' },
  })
  assert.equal(rejectedAfterExit.res.code, 503)
  assert.equal(b.serverCloses.length, closesBeforeError + 2)
  active.req.emit('close')
})
