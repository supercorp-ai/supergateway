import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway, Response } from './helpers/observed-gateway.js'
import { enableFakeTimers } from './helpers/fake-timers.js'
import { initialize } from './helpers/gateway-process.js'

test('stateless lifetime waits for dispatch, pending replies and one-way delivery, then closes once', async (t) => {
  enableFakeTimers(t)
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
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
  const first = await b.request('POST', '/mcp', { body: initialize(0) })
  const child = b.children[0],
    transport = b.transports[0]
  assert.equal(
    child.kills,
    0,
    'handleRequest resolution is not response completion',
  )
  first.res.emit('close')
  assert.equal(child.kills, 0, 'closed connection does not cancel pending work')
  child.stdout.emit(
    'data',
    Buffer.from('{"jsonrpc":"2.0","id":0,"result":{}}\n'),
  )
  await flush()
  assert.deepEqual(transport.sent, [{ jsonrpc: '2.0', id: 0, result: {} }])
  assert.equal(child.kills, 1)
  assert.equal(b.serverCloses.length, 1)
  child.stdout.emit(
    'data',
    Buffer.from('{"jsonrpc":"2.0","method":"notifications/message"}\n'),
  )
  await flush()
  assert.equal(b.serverCloses.length, 1, 'late output cannot repeat release')

  // Transport rejection: no child request was dispatched, but close releases it.
  const prototype = Object.getPrototypeOf(transport)
  const rejectDispatch = t.mock.method(
    prototype,
    'handleRequest',
    async () => {},
  )
  const rejected = await b.request('POST', '/mcp', { body: initialize(1) })
  rejectDispatch.mock.restore()
  const failingClose = t.mock.method(
    Object.getPrototypeOf(b.serverCloses[0]),
    'close',
    async () => {
      throw new Error('close failed')
    },
  )
  rejected.res.emit('close')
  await flush()
  assert.equal(b.children[1].kills, 1)
  assert.deepEqual(b.errors.at(-1), [
    'Failed to close completed stateless request',
    new Error('close failed'),
  ])
  failingClose.mock.restore()

  let releaseDispatch!: () => void
  const delayed = t.mock.method(
    prototype,
    'handleRequest',
    async (_req: unknown, res: Response) => {
      res.emit('close')
      await new Promise<void>((resolve) => {
        releaseDispatch = resolve
      })
    },
  )
  const dispatch = b.request('POST', '/mcp', { body: initialize(2) })
  await flush()
  assert.equal(
    b.children[2].kills,
    0,
    'close before dispatch settles cannot race setup',
  )
  releaseDispatch()
  await dispatch
  assert.equal(b.children[2].kills, 1)
  delayed.mock.restore()

  for (const exited of [false, true]) {
    const failure = t.mock.method(prototype, 'handleRequest', async () => {
      if (exited) b.children.at(-1)!.emit('exit', 17, null)
      throw new Error('dispatch failed')
    })
    const before = b.serverCloses.length
    const result = await b.request('POST', '/mcp', { body: initialize(3) })
    assert.equal(result.res.code, 500)
    assert.equal(b.children.at(-1)!.kills, 1)
    assert.equal(b.serverCloses.length, before + (exited ? 0 : 1))
    assert.deepEqual(b.errors.at(-1), [
      'Error handling MCP request:',
      new Error('dispatch failed'),
    ])
    failure.mock.restore()
  }

  const partialResponse = t.mock.method(
    prototype,
    'handleRequest',
    async (_req: unknown, res: Response) => {
      res.headersSent = true
      throw new Error('dispatch failed after headers')
    },
  )
  const partial = await b.request('POST', '/mcp', { body: initialize(4) })
  assert.equal(
    partial.res.code,
    200,
    'headers already sent: do not write a second status',
  )
  assert.equal(
    partial.res.body,
    undefined,
    'do not append JSON to an already started response',
  )
  assert.equal(b.children.at(-1)!.kills, 1)
  partialResponse.mock.restore()

  for (const ending of ['deadline', 'exit', 'error'] as const) {
    const request = await b.request('POST', '/mcp', {
      body: { jsonrpc: '2.0', method: 'notifications/test' },
    })
    const peer = b.children.at(-1)!,
      stream = b.transports.at(-1)!
    let ended = 0
    Object.assign(peer.stdin, {
      end: () => {
        ended++
      },
    })
    request.res.emit('close')
    assert.equal(ended, 0, 'HTTP 202 must not interrupt auto-initialization')
    const init = JSON.parse(peer.writes[0])
    peer.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: init.id, result: {} }) + '\n',
      ),
    )
    assert.deepEqual(
      peer.writes.slice(1).map((line) => JSON.parse(line)),
      [
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', method: 'notifications/test' },
      ],
    )
    assert.equal(ended, 1)
    peer.stdout.emit(
      'data',
      Buffer.from('{"jsonrpc":"2.0","method":"notifications/message"}\n'),
    )
    await flush()
    assert.equal(
      ended,
      1,
      'late output must not start another EOF grace period',
    )
    t.mock.timers.tick(4999)
    assert.equal(peer.kills, 0)
    const before = b.serverCloses.length
    if (ending === 'exit') peer.emit('exit', 0, null)
    if (ending === 'error')
      peer.stdin.emit('error', new Error('late I/O failure'))
    await flush()
    t.mock.timers.tick(1)
    await flush()
    assert.equal(peer.kills, 1)
    assert.equal(
      b.serverCloses.length,
      before + (ending === 'deadline' ? 1 : 0),
      'exit/error clears the grace timer',
    )
    assert.equal(
      stream.sent.some((message) => message.id === init.id),
      false,
      'auto-init response stays internal',
    )
  }

  // Observe resource release independently: a cancelled callback that merely
  // becomes a no-op would still retain its timer handle until the deadline.
  t.mock.timers.reset()
  const timers = () =>
    process.getActiveResourcesInfo().filter((type) => type === 'Timeout').length
  for (const ending of ['exit', 'error'] as const) {
    const request = await b.request('POST', '/mcp', {
      body: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: initialize().params,
      },
    })
    const peer = b.children.at(-1)!
    Object.assign(peer.stdin, { end() {} })
    const before = timers()
    request.res.emit('close')
    assert.equal(
      timers(),
      before + 1,
      'positive control: grace timer owns a live handle',
    )
    if (ending === 'exit') peer.emit('exit', 0, null)
    else peer.stdin.emit('error', new Error('notification pipe failed'))
    await flush()
    assert.equal(
      timers(),
      before,
      `${ending} releases the timer without waiting five seconds`,
    )
  }

  const failedRequest = await b.request('POST', '/mcp', {
    body: initialize(77),
  })
  const failedPeer = b.children.at(-1)!,
    failedTransport = b.transports.at(-1)!
  const beforeFailure = b.serverCloses.length
  failedPeer.stdin.emit('error', new Error('request pipe failed'))
  await flush()
  assert.equal(failedRequest.res.destroyed, true)
  assert.equal(failedTransport.closes, 1)
  assert.equal(
    b.serverCloses.length,
    beforeFailure,
    'I/O failure owns termination; HTTP close must not start a second completion cleanup',
  )
})
