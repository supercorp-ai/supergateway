import { test, mock, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
const sdk = await import('../src/lib/modernSdk.js')
let b: any
mock.module(new URL('../src/lib/modernSdk.js', import.meta.url).href, {
  namedExports: {
    ...sdk,
    classifyInboundRequest(input: any) {
      b.classified = input
      return sdk.classifyInboundRequest(input)
    },
    Client: class {
      constructor(...args: unknown[]) {
        b.clientArgs = args
        return b.backend
      }
    },
    McpServer: class {
      constructor(...args: unknown[]) {
        b.serverArgs = args
        return b.frontend
      }
    },
    createMcpHandler(factory: unknown, options: unknown) {
      b.factory = factory
      b.handlerOptions = options
      return b.handler
    },
    toNodeHandler(handler: unknown, options: unknown) {
      b.adapterHandler = handler
      b.adapterOptions = options
      return async (...args: unknown[]) => {
        b.handled.push(args)
        if (b.openFactory) {
          const product = await b.factory({})
          b.opened(product)
          await b.completed
        }
      }
    },
  },
})
after(() => mock.restoreAll())
const { createModernHttp } = await import('../src/lib/modernHttp.js')
function setup(capabilities: Record<string, unknown> = {}) {
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableFinished: false,
  })
  const handlers = new Map<string, Function>()
  const tools = new Map<string, { definition: any; invoke: Function }>()
  const calls: any[] = [],
    errors: unknown[][] = []
  const backend = {
    async connect(...args: any[]) {
      b.connected = args
    },
    async close() {
      b.closed++
    },
    getServerCapabilities: () => capabilities,
    getServerVersion: () => ({ name: 'peer', version: '2' }),
    getInstructions: () => 'peer instructions',
    async request(...args: any[]) {
      calls.push(args)
      return b.respond(...args)
    },
  }
  const protocol: any = {
    setRequestHandler: (name: string, handler: Function) =>
      handlers.set(name, handler),
    registerCapabilities: (value: unknown) => {
      b.advertised = value
    },
  }
  const frontend = {
    server: protocol,
    registerTool(name: string, definition: unknown, invoke: Function) {
      tools.set(name, { definition, invoke })
    },
  }
  b = {
    backend,
    frontend,
    protocol,
    response,
    handlers,
    tools,
    calls,
    errors,
    closed: 0,
    handled: [],
    handlerClosed: 0,
    respond: () => ({ tools: [] }),
    handler: {
      close: async () => {
        b.handlerClosed++
      },
    },
  }
  const children = {
    closing: false,
    spawnOptions: { shell: true, detached: true },
    own: () => async () => {},
  } as any
  b.children = children
  b.bridge = createModernHttp({
    stdioCmd: 'peer --stdio',
    children,
    logger: {
      info() {},
      error(...args: unknown[]) {
        errors.push(args)
      },
    },
  })
  b.abort = () => {
    response.destroyed = true
    response.emit('close')
  }
  b.completed = new Promise<void>((resolve) => {
    b.finish = resolve
  })
  b.open = () =>
    new Promise((resolve, reject) => {
      b.openFactory = true
      b.opened = resolve
      b.running = b.bridge
        .handle(
          {
            headers: {},
            body: {
              jsonrpc: '2.0',
              id: 1,
              method: 'server/discover',
              params: {
                _meta: {
                  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                },
              },
            },
          },
          response,
        )
        .catch(reject)
    })
  return b
}
afterEach(async () => {
  b.finish()
  await b.running
  b.protocol.onclose?.()
})
const ctx = (meta?: Record<string, unknown>) => ({
  mcpReq: {
    signal: new AbortController().signal,
    _meta: meta,
    notify: async () => {},
  },
})

test('modern adapter uses SDK classification and passes the parsed request to the Node adapter', async () => {
  const s = setup()
  const response = new EventEmitter()
  const legacy = {
    headers: {},
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  }
  assert.equal(await s.bridge.handle(legacy, response), false)
  assert.deepEqual(s.handled, [])
  const modern = {
    headers: {
      'mcp-protocol-version': ['2026-07-28', '2026-07-28'],
      'mcp-method': ['server/discover'],
      'mcp-name': ['a', 'b'],
    },
    body: {
      jsonrpc: '2.0',
      id: 2,
      method: 'server/discover',
      params: {
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    },
  }
  assert.equal(await s.bridge.handle(modern, response), true)
  assert.deepEqual(s.handled, [[modern, response, modern.body]])
  assert.deepEqual(s.classified, {
    httpMethod: 'POST',
    body: modern.body,
    protocolVersionHeader: '2026-07-28, 2026-07-28',
    mcpMethodHeader: 'server/discover',
    mcpNameHeader: 'a, b',
  })
  assert.equal(s.adapterHandler, s.handler)
  assert.equal(s.handlerOptions.legacy, 'reject')
  const e = new Error('adapter failed')
  s.handlerOptions.onerror(e)
  s.adapterOptions.onerror(e)
  assert.deepEqual(s.errors, [
    ['Modern HTTP error:', e],
    ['Modern HTTP adapter error:', e],
  ])
  await s.bridge.close()
  assert.equal(s.handlerClosed, 1)
})

test('modern factory with an empty backend advertises no unsupported features and releases on close', async () => {
  const s = setup()
  assert.equal(await s.open(), s.frontend)
  assert.deepEqual(s.clientArgs[1], { capabilities: {} })
  assert.deepEqual(s.serverArgs, [
    { name: 'peer', version: '2' },
    { capabilities: {}, instructions: 'peer instructions' },
  ])
  assert.deepEqual(s.advertised, {})
  assert.equal(s.handlers.size, 0)
  assert.equal(s.tools.size, 0)
  assert.ok(s.connected[1].signal instanceof AbortSignal)
  s.protocol.onclose()
  assert.equal(s.closed, 1)
  s.abort()
  assert.equal(s.closed, 1, 'close detaches the abort listener')
  const e = new Error('server error')
  s.protocol.onerror(e)
  assert.deepEqual(s.errors, [['Modern HTTP error:', e]])
})

test('modern factory forwards every advertised surface, user metadata, schemas and progress', async () => {
  const s = setup({
    tools: { listChanged: true },
    resources: { subscribe: true },
    prompts: {},
    completions: {},
    logging: {},
  })
  const definition = {
    name: 'tool',
    title: 'Title',
    description: 'Description',
    icons: [{ src: 'https://example.com/icon.png' }],
    annotations: { readOnlyHint: true },
    _meta: { custom: true },
    inputSchema: { type: 'object', properties: {} },
    outputSchema: { type: 'object', properties: {} },
  }
  s.respond = ({ params }: any) =>
    params.cursor
      ? { tools: [{ name: 'plain', inputSchema: { type: 'object' } }] }
      : { tools: [definition], nextCursor: 'page2' }
  await s.open()
  assert.deepEqual(
    s.calls.map((call: any[]) => call[0]),
    [
      { method: 'tools/list', params: { cursor: undefined } },
      { method: 'tools/list', params: { cursor: 'page2' } },
    ],
  )
  assert.deepEqual(s.advertised, {
    tools: { listChanged: false },
    resources: { listChanged: false, subscribe: false },
    prompts: { listChanged: false },
    completions: {},
  })
  assert.deepEqual([...s.tools.keys()], ['tool', 'plain'])
  const registered = s.tools.get('tool')
  for (const key of ['title', 'description', 'icons', 'annotations', '_meta'])
    assert.deepEqual(registered.definition[key], (definition as any)[key])
  assert.ok(registered.definition.inputSchema)
  assert.ok(registered.definition.outputSchema)
  assert.equal(s.tools.get('plain').definition.outputSchema, undefined)
  const result = { content: [{ type: 'text', text: 'reply' }] }
  s.respond = () => result
  const progress: unknown[] = []
  const context = ctx({ progressToken: 'client-token', custom: 'kept' })
  context.mcpReq.notify = async (message?: any) => {
    progress.push(message)
  }
  assert.equal(await registered.invoke({ value: 4 }, context), result)
  const sent = s.calls.at(-1)
  assert.deepEqual(sent[0], {
    method: 'tools/call',
    params: {
      name: 'tool',
      arguments: { value: 4 },
      _meta: context.mcpReq._meta,
    },
  })
  assert.equal(sent[1].signal, context.mcpReq.signal)
  sent[1].onprogress({ progress: 1, total: 2 })
  assert.deepEqual(progress, [
    {
      method: 'notifications/progress',
      params: { progress: 1, total: 2, progressToken: 'client-token' },
    },
  ])
  const failedProgress = new Error('stream closed')
  context.mcpReq.notify = async () => {
    throw failedProgress
  }
  sent[1].onprogress({ progress: 2 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(s.errors, [['Failed to forward progress:', failedProgress]])
  assert.deepEqual(
    [...s.handlers.keys()],
    [
      'resources/list',
      'resources/templates/list',
      'resources/read',
      'prompts/list',
      'prompts/get',
      'completion/complete',
    ],
  )
  for (const [method, handler] of s.handlers) {
    const context = ctx()
    assert.equal(
      await handler({ method, params: { value: method } }, context),
      result,
    )
    const [request, options] = s.calls.at(-1)
    assert.deepEqual(request, {
      method,
      params: { value: method, _meta: undefined },
    })
    assert.equal(options.signal, context.mcpReq.signal)
    assert.equal(options.onprogress, undefined)
  }
  await s.tools.get('plain').invoke({}, ctx({ custom: 'only' }))
  assert.equal(s.calls.at(-1)[1].onprogress, undefined)
})

test('modern forwarding preserves protocol errors and conceals internal child failures', async () => {
  const s = setup({ resources: {} })
  await s.open()
  const protocolError = new sdk.ProtocolError(-32602, 'invalid value', {
    field: 'value',
  })
  s.respond = () => {
    throw protocolError
  }
  await assert.rejects(
    s.handlers.get('resources/read')({ method: 'resources/read' }, ctx()),
    (error) => error === protocolError,
  )
  assert.deepEqual(s.errors, [])
  const failure = new Error('private child diagnostic')
  s.respond = () => {
    throw failure
  }
  await assert.rejects(
    s.handlers.get('resources/read')({ method: 'resources/read' }, ctx()),
    (error: any) => error.code === -32603 && !error.message.includes('private'),
  )
  assert.deepEqual(s.errors, [['MCP request failed:', failure]])
  s.respond = () => ({ custom: 'result' })
  const request = { method: 'custom/echo', params: { value: 7 } }
  const context = ctx()
  assert.deepEqual(await s.protocol.fallbackRequestHandler(request, context), {
    custom: 'result',
  })
  assert.equal(s.calls.at(-1)[0], request)
  assert.equal(s.calls.at(-1)[2].signal, context.mcpReq.signal)
})

for (const failure of [
  'aborted',
  'closing',
  'connect',
  'pagination',
] as const) {
  test(`modern setup ${failure} releases the backend and leaves no abort listener`, async () => {
    const s = setup({ tools: {} })
    const error = new Error('connect failed')
    if (failure === 'aborted') s.abort()
    if (failure === 'closing') s.children.closing = true
    if (failure === 'connect')
      s.backend.connect = async () => {
        throw error
      }
    if (failure === 'pagination')
      s.respond = () => ({ tools: [], nextCursor: 'same' })
    await assert.rejects(
      s.open(),
      failure === 'aborted'
        ? /aborted/
        : failure === 'pagination'
          ? /repeated/
          : failure === 'closing'
            ? /shutting down/
            : error,
    )
    assert.equal(s.closed, 1)
    s.abort()
    assert.equal(s.closed, 1)
  })
}

test('modern request abort closes its connected backend', async () => {
  const s = setup()
  await s.open()
  s.abort()
  assert.equal(s.closed, 1)
})

test('completed HTTP response does not abort the request and removes its listener', async () => {
  const s = setup()
  await s.open()
  assert.equal(s.response.listenerCount('close'), 1)
  s.response.writableFinished = true
  s.response.emit('close')
  assert.equal(s.connected[1].signal.aborted, false)
  s.finish()
  await s.running
  assert.equal(s.response.listenerCount('close'), 0)
})
