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
        async close() {
          b.closes++
          ;(this as any).onclose?.()
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
  assert.equal(s.closes, 1)
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
