import { test, mock, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const sdk = await import('../src/lib/modernSdk.js')
let b: any
mock.module(new URL('../src/lib/modernSdk.js', import.meta.url).href, {
  namedExports: {
    ...sdk,
    toNodeHandler(handler: any, options: any) {
      b.adapterOptions = options
      return async (req: any, _res: any, body: any) => {
        b.adapterBody = body
        b.beforeFetch?.()
        const response = await handler.fetch(
          new Request('http://localhost/mcp', {
            method: 'POST',
            headers: req.headers,
            body: JSON.stringify(body),
          }),
        )
        b.httpStatus = response.status
        b.contentType = response.headers.get('content-type')
        b.body = await response.text()
      }
    },
  },
})
mock.module(
  new URL('../src/lib/ownedStdioTransport.js', import.meta.url).href,
  {
    namedExports: {
      OwnedStdioTransport: class {
        constructor(...args: any[]) {
          b.constructorArgs = args
          b.child = this
        }
        async start() {
          b.starts++
          await b.start()
        }
        async send(message: any) {
          b.sent.push(message)
          await b.send(message)
        }
        async finish() {
          await b.finish()
        }
        async close() {
          b.closes++
          ;(this as any).onclose?.()
          await b.close()
        }
      },
    },
  },
)
after(() => mock.restoreAll())
const { createModernHttp } = await import('../src/lib/modernHttp.js')
function setup() {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    status(code: number) {
      b.httpStatus = code
      return this
    },
    json(message: any) {
      b.body = JSON.stringify(message)
      return this
    },
  })
  b = {
    response,
    starts: 0,
    closes: 0,
    sent: [],
    errors: [],
    start: async () => {},
    finish: async () => {},
    close: async () => {},
    send: async (message: any) =>
      b.child.onmessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { opaque: 'preserved' },
      }),
    children: { closing: false },
  }
  b.logger = {
    info() {},
    error(...args: any[]) {
      b.errors.push(args)
    },
  }
  b.bridge = createModernHttp({
    stdioCmd: 'peer --stdio',
    children: b.children,
    logger: b.logger,
  })
  b.request = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-method': 'server/discover',
      'mcp-protocol-version': '2026-07-28',
    },
    body: {
      jsonrpc: '2.0',
      id: 0,
      method: 'server/discover',
      params: {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'original',
            version: '7',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
          custom: 'opaque',
        },
      },
    },
  }
  b.open = () => (b.running = b.bridge.handle(b.request, response))
  return b
}
afterEach(async () => {
  await b.bridge.close()
  await b.running?.catch(() => {})
})
const tick = () => new Promise((resolve) => setImmediate(resolve))

test('relay keeps IDs, client identity and opaque results without inserting initialize or discovery calls', async () => {
  const s = setup()
  assert.equal(await s.open(), true)
  assert.deepEqual(s.constructorArgs, ['peer --stdio', s.children, s.logger])
  assert.deepEqual(s.sent, [s.request.body])
  assert.equal(s.adapterBody, s.request.body)
  assert.equal(s.httpStatus, 200)
  assert.equal(s.contentType, 'application/json')
  assert.deepEqual(JSON.parse(s.body), {
    jsonrpc: '2.0',
    id: 0,
    result: { opaque: 'preserved' },
  })
  assert.equal(s.starts, 1)
  assert.equal(s.closes, 1)
  assert.equal(s.response.listenerCount('close'), 0)
})

test('relay leaves legacy initialization to the existing handler', async () => {
  const s = setup()
  s.request.headers = {}
  s.request.body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' },
  }
  assert.equal(await s.open(), false)
  assert.equal(s.starts, 0)
  assert.equal(s.child, undefined)
})

for (const id of [17, 'opaque', null]) {
  test(`classifier rejection echoes a valid ID (${id}) without spawning`, async () => {
    const s = setup()
    s.request.body.id = id
    s.request.headers['mcp-method'] = ['tools/list']
    assert.equal(await s.open(), true)
    assert.equal(s.httpStatus, 400)
    assert.equal(JSON.parse(s.body).id, id)
    assert.ok(JSON.parse(s.body).error)
    assert.equal(s.starts, 0)
    assert.equal(s.child, undefined)
  })
}

test('progress and the final result retain their wire payloads and order', async () => {
  const s = setup()
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 'token', progress: 1, total: 2 },
  }
  const result = {
    jsonrpc: '2.0',
    id: 0,
    result: {
      resultType: 'input_required',
      inputRequests: {},
      requestState: 'opaque/+=',
    },
  }
  s.send = async () => {
    s.child.onmessage(notification)
    s.child.onmessage(result)
  }
  await s.open()
  assert.equal(s.contentType, 'text/event-stream')
  assert.deepEqual(
    s.body
      .split('\n')
      .filter((line: string) => line.startsWith('data:'))
      .map((line: string) => JSON.parse(line.slice(5))),
    [notification, result],
  )
  // The child minted continuation state, so it waits for the next round
  // instead of exiting with this exchange. Shutdown releases it.
  assert.equal(s.closes, 0)
  await s.bridge.close()
  assert.equal(s.closes, 1)
})

const TOKEN = 'v1.opaque/+=signed-by-the-child'
function continuationSetup() {
  const s = setup()
  s.request.body.method = 'tools/call'
  s.request.headers['mcp-method'] = 'tools/call'
  s.request.headers['mcp-name'] = 'roots'
  s.request.body.params.name = 'roots'
  s.request.body.params.arguments = {}
  s.send = async (message: any) => {
    if (message.method === 'tools/list')
      s.child.onmessage({
        jsonrpc: '2.0',
        id: message.id,
        result: { tools: [{ name: 'roots', inputSchema: { properties: {} } }] },
      })
    else
      s.child.onmessage({
        jsonrpc: '2.0',
        id: message.id,
        result:
          typeof message.params.requestState === 'string'
            ? { resultType: 'complete', content: [] }
            : {
                resultType: 'input_required',
                inputRequests: {},
                requestState: TOKEN,
              },
      })
  }
  s.nextRound = (id: number, extra: Record<string, unknown> = {}) => {
    s.request = {
      ...s.request,
      body: {
        ...s.request.body,
        id,
        params: {
          ...s.request.body.params,
          inputResponses: { locations: { roots: [] } },
          requestState: TOKEN,
          ...extra,
        },
      },
    }
  }
  return s
}

test('the child that minted continuation state serves the next round without restarting', async () => {
  const s = continuationSetup()
  await s.open()
  assert.equal(JSON.parse(s.body).result.requestState, TOKEN)
  assert.equal(s.starts, 1)
  assert.equal(s.closes, 0)
  s.nextRound(1)
  await s.open()
  assert.deepEqual(JSON.parse(s.body), {
    jsonrpc: '2.0',
    id: 1,
    result: { resultType: 'complete', content: [] },
  })
  assert.equal(s.starts, 1, 'no second child was started')
  assert.equal(
    s.sent[3],
    s.request.body,
    'the echoed state reaches the child untouched',
  )
  assert.equal(s.closes, 1, 'the completed operation releases its child')
  assert.equal(s.response.listenerCount('close'), 0)
})

test('a continuation token nobody retained starts a fresh child', async () => {
  const s = continuationSetup()
  s.nextRound(1, { requestState: 'never minted here' })
  await s.open()
  assert.equal(s.starts, 1)
  assert.equal(s.sent[1].params.requestState, 'never minted here')
  assert.equal(s.closes, 1)
})

test('a failed round releases the retained child instead of keeping it', async () => {
  const s = continuationSetup()
  await s.open()
  assert.equal(s.closes, 0)
  const send = s.send
  s.send = async (message: any) => {
    if (message.method === 'tools/call')
      throw new Error('private write failure')
    await send(message)
  }
  s.nextRound(1)
  await s.open()
  assert.equal(JSON.parse(s.body).error.code, -32603)
  assert.equal(s.closes, 1)
  s.send = send
  s.nextRound(2)
  await s.open()
  assert.equal(s.starts, 2, 'the released child is not reused')
})

test('a round that disconnects before dispatch leaves the child waiting for a retry', async () => {
  const s = continuationSetup()
  await s.open()
  s.nextRound(1)
  s.response.destroyed = true
  await s.open()
  assert.equal(s.closes, 0)
  assert.equal(s.sent.length, 2, 'nothing was sent to the child')
  s.response.destroyed = false
  s.nextRound(2)
  await s.open()
  assert.equal(JSON.parse(s.body).result.resultType, 'complete')
  assert.equal(s.starts, 1)
  assert.equal(s.closes, 1)
})

test('a notification carrying continuation state never claims a retained child', async () => {
  const s = continuationSetup()
  await s.open()
  const retainedChild = s.child
  s.nextRound(1)
  delete s.request.body.id
  s.request.body.method = 'notifications/cancelled'
  s.request.headers['mcp-method'] = 'notifications/cancelled'
  delete s.request.headers['mcp-name']
  s.request.body.params = {
    _meta: s.request.body.params._meta,
    requestId: 0,
    requestState: TOKEN,
  }
  s.send = async () => {}
  await s.open()
  assert.equal(s.httpStatus, 202)
  assert.equal(s.starts, 2, 'the notification runs its own child')
  assert.notEqual(s.child, retainedChild)
  assert.equal(s.closes, 1, 'only the notification child exits')
  await s.bridge.close()
  assert.equal(s.closes, 2)
})

for (const failure of [
  'start',
  'send',
  'exit',
  'reverse',
  'closing',
] as const) {
  test(`relay ${failure} settles with a private internal error and closes its child`, async () => {
    const s = setup()
    const error = new Error('private diagnostic')
    if (failure === 'start')
      s.start = async () => {
        throw error
      }
    if (failure === 'send')
      s.send = async () => {
        throw error
      }
    if (failure === 'exit')
      s.send = async () => {
        s.child.onclose()
      }
    if (failure === 'reverse')
      s.send = async () => {
        s.child.onmessage({
          jsonrpc: '2.0',
          id: 'reverse',
          method: 'roots/list',
        })
      }
    if (failure === 'closing') s.children.closing = true
    await s.open()
    assert.deepEqual(JSON.parse(s.body), {
      jsonrpc: '2.0',
      id: 0,
      error: { code: -32603, message: 'MCP server process failed' },
    })
    assert.equal(s.closes, 1)
    assert.equal(s.response.listenerCount('close'), 0)
    assert.ok(s.errors.length > 0)
  })
}

test('an already disconnected response starts no child', async () => {
  const s = setup()
  s.response.destroyed = true
  assert.equal(await s.open(), true)
  assert.equal(s.starts, 0)
  assert.equal(s.closes, 1)
})

for (const reason of ['disconnect', 'shutdown'] as const) {
  test(`${reason} during startup releases a late child without dispatching`, async () => {
    const s = setup()
    let resume!: () => void
    s.start = () =>
      new Promise<void>((resolve) => {
        resume = resolve
      })
    const pending = s.open()
    const rejected = assert.rejects(pending, /closed/i)
    await tick()
    assert.equal(s.starts, 1)
    if (reason === 'disconnect') s.response.emit('close')
    else await s.bridge.close()
    resume()
    await rejected
    await tick()
    assert.deepEqual(s.sent, [])
    assert.equal(s.response.listenerCount('close'), 0)
  })
}

for (const outcome of [
  'success',
  'notification',
  'wrong-id',
  'write-failure',
  'child-error',
  'backend-error',
  'abort',
  'abort-between-pages',
  'abort-after-schema',
] as const) {
  test(`tool-header lookup ${outcome} preserves the original call or stops dispatch`, async () => {
    const s = setup()
    s.request.body.method = 'tools/call'
    s.request.headers['mcp-method'] = 'tools/call'
    s.request.headers['mcp-name'] = 'tool'
    s.request.body.params.name = 'tool'
    s.request.body.params.arguments = { value: 'hé' }
    s.request.body.params._meta.progressToken = 'original-token'
    s.request.headers['mcp-param-value'] = '=?base64?aMOp?='
    s.send = async (message: any) => {
      if (message.method === 'tools/list') {
        assert.equal(message.params._meta.progressToken, undefined)
        assert.notEqual(message.id, 0)
        if (outcome === 'write-failure')
          throw new Error('private write failure')
        if (outcome === 'child-error') {
          s.child.onerror(new Error('private lookup pipe failure'))
          return
        }
        if (outcome === 'abort') {
          s.response.emit('close')
          return
        }
        if (outcome === 'abort-between-pages') {
          s.child.onmessage({
            jsonrpc: '2.0',
            id: message.id,
            result: { tools: [], nextCursor: 'later' },
          })
          s.response.emit('close')
          return
        }
        if (outcome === 'notification')
          s.child.onmessage({
            jsonrpc: '2.0',
            method: 'notifications/message',
            params: { data: 'lookup-only' },
          })
        if (outcome === 'wrong-id')
          s.child.onmessage({
            jsonrpc: '2.0',
            id: 'wrong',
            result: { tools: [] },
          })
        s.child.onmessage(
          outcome === 'backend-error'
            ? {
                jsonrpc: '2.0',
                id: message.id,
                error: { code: -32601, message: 'private lookup failure' },
              }
            : {
                jsonrpc: '2.0',
                id: message.id,
                result: {
                  tools: [
                    {
                      name: 'tool',
                      inputSchema: {
                        properties: {
                          value: { type: 'string', 'x-mcp-header': 'Value' },
                        },
                      },
                    },
                  ],
                },
              },
        )
        if (outcome === 'abort-after-schema') s.response.emit('close')
      } else
        s.child.onmessage({
          jsonrpc: '2.0',
          id: message.id,
          result: { opaque: 'reply' },
        })
    }
    if (outcome.startsWith('abort')) await assert.rejects(s.open(), /closed/)
    else {
      await s.open()
      const body = JSON.parse(s.body)
      if (
        outcome === 'write-failure' ||
        outcome === 'backend-error' ||
        outcome === 'child-error'
      )
        assert.equal(body.error.code, -32603)
      else {
        assert.deepEqual(body.result, { opaque: 'reply' })
        assert.deepEqual(s.sent[1], s.request.body)
      }
    }
    assert.equal(s.closes, 1)
  })
}
for (const fails of [false, true])
  test(`notification delivery is awaited before HTTP completion (${fails})`, async () => {
    const s = setup()
    delete s.request.body.id
    let drained = false
    s.send = async () => {}
    s.finish = async () => {
      await tick()
      if (fails) throw new Error('private drain failure')
      drained = true
    }
    await s.open()
    assert.equal(drained, !fails)
    assert.equal(s.httpStatus, fails ? 500 : 202)
    assert.equal(s.closes, 1)
  })
test('late child messages cannot write to a completed response', async () => {
  const s = setup()
  await s.open()
  const body = s.body
  s.child.onmessage({ jsonrpc: '2.0', id: 0, result: { late: true } })
  s.child.onerror(new Error('late error'))
  await tick()
  assert.equal(s.body, body)
  assert.equal(s.closes, 1)
})

test('cleanup rejection is logged and releases the response listener', async () => {
  const s = setup()
  const error = new Error('close failed')
  s.close = async () => {
    throw error
  }
  await s.open()
  assert.equal(s.response.listenerCount('close'), 0)
  assert.deepEqual(s.errors, [['Modern request cleanup failed:', error]])
  await s.bridge.close()
  assert.equal(s.closes, 1)
})

for (const streaming of [false, true])
  for (const code of [-32601, -32020, -32021, -32022, -32099])
    test(`backend error ${code} preserves its payload with stream=${streaming}`, async () => {
      const s = setup()
      const error = {
        jsonrpc: '2.0',
        id: 0,
        error: { code, message: 'backend message', data: { kept: true } },
      }
      s.send = async () => {
        if (streaming)
          s.child.onmessage({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progress: 1 },
          })
        s.child.onmessage(error)
      }
      await s.open()
      assert.equal(
        s.httpStatus,
        streaming || code === -32099 ? 200 : code === -32601 ? 404 : 400,
      )
      if (streaming) assert.ok(s.body.includes(JSON.stringify(error)))
      else assert.deepEqual(JSON.parse(s.body), error)
    })
test('completed request releases its cleanup callback from the active registry', async (t) => {
  const original = Set.prototype.add
  let active: Set<unknown> | undefined
  t.mock.method(
    Set.prototype,
    'add',
    function (this: Set<unknown>, value: unknown) {
      if (typeof value === 'function' && value.name === 'stop') active = this
      return original.call(this, value)
    },
  )
  const s = setup()
  await s.open()
  assert.ok(active)
  assert.equal(active.size, 0)
})
test('transport and adapter diagnostics are logged while valid replies still arrive', async () => {
  const s = setup()
  s.send = async () => {
    s.child.onmessage({
      jsonrpc: '2.0',
      id: 'unknown',
      error: { code: -32601, message: 'wrong id' },
    })
    s.child.onmessage({ jsonrpc: '2.0', id: 0, result: { kept: true } })
  }
  await s.open()
  const error = new Error('adapter diagnostic')
  s.adapterOptions.onerror(error)
  assert.equal(s.httpStatus, 200)
  assert.deepEqual(JSON.parse(s.body).result, { kept: true })
  assert.equal(s.errors[0][0], 'Modern HTTP transport error:')
  assert.match(s.errors[0][1].message, /unknown request id/)
  assert.deepEqual(s.errors[1], ['Modern HTTP adapter error:', error])
})

test('response disconnect before dispatch starts no child', async () => {
  const s = setup()
  s.beforeFetch = () => s.response.emit('close')
  await assert.rejects(s.open(), /closed/)
  assert.equal(s.starts, 0)
  assert.equal(s.closes, 1)
})
for (const body of [null, undefined])
  test(`malformed body ${body} has no invented response ID`, async () => {
    const s = setup()
    s.request.body = body
    await s.open()
    assert.equal(s.httpStatus, 400)
    assert.equal(JSON.parse(s.body).id, null)
  })
for (const id of [17, null, undefined])
  test(`HTTP rejection retains only valid request ID ${id}`, async () => {
    const s = setup()
    s.request.body.id = id
    delete s.request.headers['content-type']
    await s.open()
    assert.equal(s.httpStatus, 415)
    assert.equal(JSON.parse(s.body).id, id === 17 ? 17 : null)
  })
test('missing Accept is rejected before a child is constructed', async () => {
  const s = setup()
  delete s.request.headers.accept
  await s.open()
  assert.equal(s.httpStatus, 406)
  assert.equal(s.starts, 0)
})
test('unexpected response to a notification cannot become an HTTP reply', async () => {
  const s = setup()
  delete s.request.body.id
  s.send = async () =>
    s.child.onmessage({
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'unexpected' },
    })
  await s.open()
  assert.equal(s.httpStatus, 202)
  assert.equal(s.body, '')
  assert.equal(s.closes, 1)
})
test('a rejected error write still closes the request', async (t) => {
  const s = setup()
  s.start = async () => {
    throw new Error('start failed')
  }
  t.mock.method(
    sdk.PerRequestHTTPServerTransport.prototype,
    'send',
    async () => {
      throw new Error('write failed')
    },
  )
  await assert.rejects(s.open(), /closed/)
  assert.equal(s.closes, 1)
  assert.ok(
    s.errors.some(
      (e: any[]) =>
        e[0] === 'Failed to send MCP error:' && e[1].message === 'write failed',
    ),
  )
})

test('notification forwarding does not perform request-only tool discovery', async () => {
  const s = setup()
  delete s.request.body.id
  s.request.body.method = 'tools/call'
  s.request.headers['mcp-method'] = 'tools/call'
  s.send = async () => {}
  await s.open()
  assert.equal(s.httpStatus, 202)
  assert.deepEqual(s.sent, [s.request.body])
})

for (const body of [null, undefined])
  test(`missing Content-Type with ${body} body rejects without inventing an ID`, async () => {
    const s = setup()
    s.request.body = body
    delete s.request.headers['content-type']
    await s.open()
    assert.equal(s.httpStatus, 415)
    assert.equal(JSON.parse(s.body).id, null)
    assert.equal(s.starts, 0)
  })
