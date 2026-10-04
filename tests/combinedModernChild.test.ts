import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CombinedModernChild,
  combinedSpeaksModern,
  type CombinedModernEntry,
  type ModernMember,
  type ModernRequestInfo,
} from '../src/lib/combinedModernChild.js'
import {
  MODERN_VERSION,
  SPEAKS_FOR_MS,
  type ModernChild,
} from '../src/lib/upstreamModernChild.js'
import { ToolNames } from '../src/lib/toolNames.js'
import { getVersion } from '../src/lib/getVersion.js'

// Servers combined, for one 2026-07-28 request. The servers are in memory:
// each instance stands for one process started for one request.

type Message = Record<string, any>
type Answers = Record<
  string,
  (request: Message) => Message | 'hold' | 'die' | 'close'
>

interface Spec {
  versions?: string[]
  capabilities?: Record<string, unknown>
  instructions?: string
  tools?: string[]
  toolPages?: string[][]
  prompts?: string[]
  resources?: string[]
  templates?: string[]
  ttlMs?: number
  cacheScope?: string
  toolNames?: ToolNames
  /** No such requests at all, as for a remote SSE server. */
  none?: boolean
  /** Said before every answer: what is no answer to the gateway's request. */
  noise?: Message[]
  /** A send that settles only when the server is closed, by failing. */
  hangSend?: boolean
  answers?: Answers
}

const logs = () => {
  const info: string[] = []
  const errors: unknown[][] = []
  return {
    info,
    errors,
    logger: {
      info: (line: string) => info.push(line),
      error: (...args: unknown[]) => errors.push(args),
    },
  }
}

function fakeMember(name: string, spec: Spec) {
  const instances: {
    declared: ModernRequestInfo
    sent: Message[]
    started: boolean
    finished: boolean
    closed: boolean
    held: unknown[]
    child: ModernChild
  }[] = []
  const hints = {
    resultType: 'complete',
    ...(spec.ttlMs === undefined ? {} : { ttlMs: spec.ttlMs }),
    ...(spec.cacheScope ? { cacheScope: spec.cacheScope } : {}),
  }
  const item = (key: string) => (id: string) => ({ [key]: id })
  const defaults: Record<string, (request: Message) => Message> = {
    'server/discover': () => ({
      result: {
        ...hints,
        supportedVersions: spec.versions ?? [MODERN_VERSION],
        capabilities: spec.capabilities ?? {},
        serverInfo: { name, version: '1' },
        ...(spec.instructions ? { instructions: spec.instructions } : {}),
      },
    }),
    'tools/list': ({ params }) => {
      const pages = spec.toolPages ?? [spec.tools ?? []]
      const page = params?.cursor ? Number(params.cursor) : 0
      return {
        result: {
          ...hints,
          tools: pages[page].map(item('name')),
          ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}),
        },
      }
    },
    'prompts/list': () => ({
      result: { ...hints, prompts: (spec.prompts ?? []).map(item('name')) },
    }),
    'resources/list': () => ({
      result: { ...hints, resources: (spec.resources ?? []).map(item('uri')) },
    }),
    'resources/templates/list': () => ({
      result: {
        ...hints,
        resourceTemplates: (spec.templates ?? []).map(item('uriTemplate')),
      },
    }),
    'tools/call': ({ params }) => ({
      result: {
        ...hints,
        content: [{ type: 'text', text: `${name} ran ${params.name}` }],
      },
    }),
    'prompts/get': ({ params }) => ({
      result: { description: `${name}: ${params.name}` },
    }),
    'resources/read': ({ params }) => ({
      result: { contents: [{ uri: params.uri, text: name }] },
    }),
    'completion/complete': () => ({
      result: { completion: { values: [name] } },
    }),
  }
  const member: ModernMember = {
    name,
    toolNames: spec.toolNames,
    ...(spec.none
      ? {}
      : {
          child: (declared) => {
            const instance = {
              declared,
              sent: [] as Message[],
              started: false,
              finished: false,
              closed: false,
              held: [] as unknown[],
              child: undefined as unknown as ModernChild,
            }
            let aborted: (() => void) | undefined
            const child: ModernChild = {
              start: async () => {
                instance.started = true
              },
              send: async (message) => {
                const request = message as Message
                instance.sent.push(request)
                if (spec.hangSend && request.method === 'tools/call')
                  return new Promise<void>((_resolve, reject) => {
                    aborted = () => reject(Error('aborted'))
                  })
                if (request.id === undefined) return
                queueMicrotask(() => {
                  if (instance.closed) return
                  const answer = (
                    spec.answers?.[request.method] ??
                    defaults[request.method] ??
                    (() => ({
                      error: { code: -32601, message: 'no such method' },
                    }))
                  )(request)
                  if (answer === 'hold') return
                  for (const message of spec.noise ?? [])
                    child.onmessage?.(message as never)
                  if (answer === 'close') {
                    child.onclose?.()
                    return
                  }
                  if (answer === 'die') {
                    child.onerror?.(Error(`${name} died`))
                    return
                  }
                  child.onmessage?.({
                    jsonrpc: '2.0',
                    id: request.id,
                    ...answer,
                  } as never)
                })
              },
              finish: async () => {
                instance.finished = true
              },
              close: async () => {
                instance.closed = true
                aborted?.()
              },
              hold: (drained) => {
                instance.held.push(drained)
              },
            }
            instance.child = child
            instances.push(instance)
            return child
          },
        }),
  }
  return {
    member,
    instances,
    /** Every message any instance was sent, as methods. */
    methods: () => instances.flatMap(({ sent }) => sent.map((m) => m.method)),
  }
}

const meta = {
  'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}

// A combined entry of `specs`, in config order; `request` makes one request
// of it, each with a combined child of its own, as the relay does.
const combine = (specs: Record<string, Spec>) => {
  const servers = Object.fromEntries(
    Object.entries(specs).map(([name, spec]) => [name, fakeMember(name, spec)]),
  )
  const log = logs()
  const entry: CombinedModernEntry = {
    name: 'tools',
    members: Object.values(servers).map(({ member }) => member),
    tables: new Map(),
    warned: new Set(),
  }
  const open = (
    declared: ModernRequestInfo = { version: MODERN_VERSION, params: {} },
  ) => {
    const child = new CombinedModernChild(entry, declared, log.logger)
    const said: Message[] = []
    const failures: string[] = []
    let closes = 0
    child.onmessage = (message) => said.push(message)
    child.onerror = (error) => failures.push(error.message)
    child.onclose = () => closes++
    const request = async (
      method: string,
      params: Message = {},
      id: string | number = 7,
    ) => {
      await child.start()
      await child.send({
        jsonrpc: '2.0',
        id,
        method,
        params: { _meta: meta, ...params },
      } as never)
      await child.finish()
      return said.find((message) => message.id === id && !('method' in message))
    }
    return { child, said, failures, closes: () => closes, request }
  }
  // One request of its own.
  const request = (method: string, params: Message = {}) =>
    open().request(method, params)
  return { entry, servers, open, request, ...log }
}

const names = (items: { name: string }[]) => items.map((item) => item.name)

// --- server/discover ---

test('discover is answered as one server: common versions, every capability, instructions by name', async () => {
  const { request, servers } = combine({
    git: {
      versions: ['2025-11-25', MODERN_VERSION, '2027-01-01'],
      capabilities: { tools: { listChanged: true } },
      instructions: 'Use git carefully.',
      ttlMs: 60_000,
    },
    docs: {
      versions: [MODERN_VERSION, '2027-01-01'],
      capabilities: { resources: {}, tools: {} },
      ttlMs: 5_000,
      cacheScope: 'private',
    },
    files: { capabilities: 'none' as never, instructions: 'Files are local.' },
  })
  assert.deepEqual((await request('server/discover'))!.result, {
    resultType: 'complete',
    supportedVersions: [MODERN_VERSION],
    capabilities: { tools: { listChanged: true }, resources: {} },
    serverInfo: { name: 'supergateway', title: 'tools', version: getVersion() },
    instructions:
      '## git\n\nUse git carefully.\n\n## files\n\nFiles are local.',
    // No longer than the shortest any allows, and privately if any is.
    ttlMs: 5_000,
    cacheScope: 'private',
  })
  // Each was started for it, asked with the client's own request, and stopped.
  for (const server of Object.values(servers)) {
    assert.equal(server.instances.length, 1)
    assert.equal(server.instances[0].started, true)
    assert.deepEqual(server.instances[0].sent[0].params, { _meta: meta })
  }
})

test('discover without instructions or cache hints has none', async () => {
  const { request } = combine({ a: {}, b: {} })
  const { result } = (await request('server/discover'))!
  assert.equal('instructions' in result, false)
  assert.equal('ttlMs' in result, false)
  assert.equal('cacheScope' in result, false)
})

test('a server that fails discover fails it for the entry', async () => {
  const { request } = combine({
    a: {},
    b: {
      answers: {
        'server/discover': () => ({ error: { code: -1, message: 'not now' } }),
      },
    },
  })
  assert.deepEqual((await request('server/discover'))!.error, {
    code: -32603,
    message: 'Server "b" failed: not now',
  })
})

// --- Lists ---

test("a list is every server's, all pages, in config order, as one page", async () => {
  const { request, servers, entry } = combine({
    paged: { toolPages: [['a', 'b'], ['c']], ttlMs: 1000 },
    plain: { tools: ['d'], ttlMs: 30 },
    none: {
      answers: {
        'tools/list': () => ({ error: { code: -32601, message: 'no tools' } }),
      },
    },
  })
  assert.deepEqual(
    (await request('tools/list', { _meta: { ...meta, progressToken: 'p' } }))!
      .result,
    {
      resultType: 'complete',
      tools: ['a', 'b', 'c', 'd'].map((name) => ({ name })),
      ttlMs: 30,
    },
  )
  // Asked without the client's progress token, which names its own request.
  assert.deepEqual(
    servers.paged.instances[0].sent.map((m) => m.params),
    [{ _meta: meta }, { _meta: meta, cursor: '1' }],
  )
  assert.deepEqual(
    [...entry.tables.get('tools/list')!.keys()],
    ['a', 'b', 'c', 'd'],
  )
  assert.deepEqual((await request('tools/list', { cursor: 'x' }))!.error, {
    code: -32602,
    message: 'Invalid cursor',
  })
})

test('the other lists are merged the same way; with no server answering, the list is empty', async () => {
  const { request } = combine({
    a: { prompts: ['p1'], resources: ['r://a'], templates: ['a://{id}'] },
    b: { prompts: ['p2'], resources: ['r://b'], templates: ['b://{id}'] },
  })
  assert.deepEqual(names((await request('prompts/list'))!.result.prompts), [
    'p1',
    'p2',
  ])
  assert.deepEqual((await request('resources/list'))!.result.resources, [
    { uri: 'r://a' },
    { uri: 'r://b' },
  ])
  assert.deepEqual(
    (await request('resources/templates/list'))!.result.resourceTemplates,
    [{ uriTemplate: 'a://{id}' }, { uriTemplate: 'b://{id}' }],
  )
  const none = combine({
    a: {
      answers: {
        'tools/list': () => ({ error: { code: -32601, message: 'x' } }),
      },
    },
  })
  assert.deepEqual((await none.request('tools/list'))!.result, { tools: [] })
})

test("a name two servers offer is the first listed one's, warned about once for the entry", async () => {
  const { request, errors, servers } = combine({
    first: { tools: ['search', 'one'] },
    second: { tools: ['search', 'two'], prompts: ['hi'] },
    third: { prompts: ['hi'] },
  })
  assert.deepEqual(names((await request('tools/list'))!.result.tools), [
    'search',
    'one',
    'two',
  ])
  await request('tools/list')
  await request('prompts/list')
  assert.deepEqual(errors, [
    [
      'tools: tool "search" is offered by "first" and "second"; clients get the one of "first", listed first. Set "toolPrefix" on one of them to keep both',
    ],
    [
      'tools: prompt "hi" is offered by "second" and "third"; clients get the one of "second", listed first',
    ],
  ])
  const called = await request('tools/call', { name: 'search' })
  assert.equal(called!.result.content[0].text, 'first ran search')
  assert.equal(servers.second.methods().includes('tools/call'), false)
})

test('a server whose list fails, repeats a cursor or is no list leaves the others', async () => {
  const { request, errors } = combine({
    dies: { answers: { 'tools/list': () => 'die' } },
    loops: {
      answers: {
        'tools/list': () => ({
          result: { tools: [{ name: 'again' }], nextCursor: 'same' },
        }),
      },
    },
    odd: { answers: { 'tools/list': () => ({ result: { tools: 'none' } }) } },
    unnamed: {
      answers: {
        'tools/list': () => ({ result: { tools: [{ title: 'x' }, null] } }),
      },
    },
    fine: { tools: ['ok'] },
  })
  assert.deepEqual((await request('tools/list'))!.result.tools, [
    { name: 'again' },
    { title: 'x' },
    null,
    { name: 'ok' },
  ])
  assert.deepEqual(errors, [
    ['tools: tools/list of server "dies" failed: dies died'],
    [
      'tools: tool "again" is offered by "loops" and "loops"; clients get the one of "loops", listed first. Set "toolPrefix" on one of them to keep both',
    ],
  ])
})

test("a server's own tool settings apply before it is combined", async () => {
  const quiet = logs().logger
  const { request, servers } = combine({
    a: { tools: ['search'] },
    b: {
      tools: ['search', 'hidden'],
      toolNames: ToolNames.of({ toolPrefix: 'b_', tools: ['search'] }, quiet),
    },
  })
  assert.deepEqual(names((await request('tools/list'))!.result.tools), [
    'search',
    'b_search',
  ])
  const called = await request('tools/call', {
    name: 'b_search',
    arguments: { q: 1 },
  })
  // The server is called by its own name.
  assert.equal(called!.result.content[0].text, 'b ran search')
  assert.deepEqual(servers.b.instances.at(-1)!.sent[0].params, {
    _meta: meta,
    name: 'search',
    arguments: { q: 1 },
  })
  assert.equal(
    (await request('tools/call', { name: 'b_hidden' }))!.error.code,
    -32602,
  )
})

// --- Requests for one server ---

test('a call starts only the server that has the tool, once the entry knows who has what', async () => {
  const { request, servers, open } = combine({
    a: { tools: ['one'] },
    b: { tools: ['two'], prompts: ['greet'] },
  })
  // The first call has to look; it asks every server for its list.
  const first = await request('tools/call', { name: 'two' })
  assert.equal(first!.result.content[0].text, 'b ran two')
  assert.deepEqual(servers.a.methods(), ['tools/list'])
  // The next does not: only the tool's server is started.
  const before = servers.a.instances.length
  const declared = { version: MODERN_VERSION, params: { 'mcp-param-x': '1' } }
  const second = open(declared)
  assert.equal(
    (await second.request('tools/call', { name: 'two' }))!.result.content[0]
      .text,
    'b ran two',
  )
  assert.equal(servers.a.instances.length, before)
  // It is told what the client's request declared.
  assert.deepEqual(servers.b.instances.at(-1)!.declared, declared)
  assert.equal(
    (await request('prompts/get', { name: 'greet' }))!.result.description,
    'b: greet',
  )
})

test('a name the table does not have is looked for once more, then refused', async () => {
  let tools = ['old']
  const { request, servers } = combine({
    a: {
      prompts: [],
      answers: {
        'tools/list': () => ({
          result: { tools: tools.map((name) => ({ name })) },
        }),
      },
    },
  })
  await request('tools/list')
  tools = ['old', 'new']
  assert.equal(
    (await request('tools/call', { name: 'new' }))!.result.content[0].text,
    'a ran new',
  )
  assert.deepEqual((await request('tools/call', { name: 'nope' }))!.error, {
    code: -32602,
    message: 'Unknown tool: nope',
  })
  assert.deepEqual((await request('tools/call'))!.error, {
    code: -32602,
    message: 'Unknown tool: undefined',
  })
  assert.deepEqual((await request('prompts/get', { name: 'x' }))!.error, {
    code: -32602,
    message: 'Unknown prompt: x',
  })
  assert.equal(servers.a.methods().includes('prompts/get'), false)
})

test('a resource goes to the server that lists it, or whose template it fits', async () => {
  const { request, servers } = combine({
    files: { resources: ['file:///etc/hosts'], templates: ['file:///{path}'] },
    db: {
      resources: ['db://users'],
      templates: ['db://{table}/{id}', 'db://raw/{+rest}'],
    },
  })
  const reader = async (uri: string) =>
    (await request('resources/read', { uri }))!.result.contents[0].text
  assert.equal(await reader('db://users'), 'db')
  assert.equal(await reader('db://orders/7'), 'db')
  // Known now: a template's server is found without asking again.
  const lists = () =>
    servers.db.methods().filter((m) => m === 'resources/templates/list').length
  const before = lists()
  assert.equal(await reader('db://raw/a/b'), 'db')
  assert.equal(lists(), before)
  assert.equal(await reader('file:///notes.txt'), 'files')
  assert.deepEqual(
    (await request('resources/read', { uri: 'other://x' }))!.error,
    {
      code: -32002,
      message: 'Resource not found',
      data: { uri: 'other://x' },
    },
  )
  assert.equal(
    (await request('resources/subscribe', { uri: 'db://users' }))!.error.code,
    -32601,
  )
})

test('a completion goes by what it refers to; any other method is not found', async () => {
  const { request } = combine({
    a: { prompts: ['greet'] },
    b: { templates: ['b://{id}'] },
  })
  const complete = (ref: unknown) =>
    request('completion/complete', { ref, argument: {} })
  assert.deepEqual(
    (await complete({ type: 'ref/prompt', name: 'greet' }))!.result,
    {
      completion: { values: ['a'] },
    },
  )
  assert.deepEqual(
    (await complete({ type: 'ref/resource', uri: 'b://{id}' }))!.result,
    {
      completion: { values: ['b'] },
    },
  )
  assert.equal(
    (await complete({ type: 'ref/prompt', name: 'nope' }))!.error.message,
    'Unknown prompt: nope',
  )
  assert.equal((await complete(undefined))!.error.code, -32002)
  assert.deepEqual((await request('custom/thing'))!.error, {
    code: -32601,
    message: 'Method not found: custom/thing',
  })
})

test("what the request's server says is the client's, and it is read no faster than the client reads", async () => {
  const { open, servers } = combine({
    a: { tools: ['wait'], answers: { 'tools/call': () => 'hold' } },
  })
  const { child, said, request } = open()
  await request('tools/list', {}, 1)
  void request('tools/call', { name: 'wait' }, 2)
  await new Promise((resolve) => setImmediate(resolve))
  const server = servers.a.instances.at(-1)!
  const progress = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progress: 1 },
  }
  server.child.onmessage!(progress as never)
  assert.deepEqual(said.at(-1), progress)
  const drained = Promise.resolve()
  child.hold(drained)
  assert.deepEqual(server.held, [drained])
  // With no server passed the request, there is nothing to hold.
  open().child.hold(drained)
})

test('a retry of a multi-round call goes to the server that has its state', async () => {
  let rounds = 0
  const { open, servers } = combine({
    a: { tools: ['other'] },
    b: {
      tools: ['ask'],
      answers: {
        'tools/call': () =>
          ++rounds === 1
            ? {
                result: {
                  resultType: 'input_required',
                  requestState: 'opaque',
                },
              }
            : { result: { resultType: 'complete', content: [] } },
      },
    },
  })
  const { request } = open()
  const first = await request('tools/call', { name: 'ask' }, 1)
  assert.equal(first!.result.resultType, 'input_required')
  const instance = servers.b.instances.at(-1)!
  // The relay asks for the tool's schema again before the retry, on the
  // same combined child: a list still goes to every server.
  const listed = await request('tools/list', {}, 'schema')
  assert.deepEqual(names(listed!.result.tools), ['other', 'ask'])
  const second = await request(
    'tools/call',
    { name: 'ask', requestState: 'opaque' },
    2,
  )
  assert.equal(second!.result.resultType, 'complete')
  assert.equal(
    instance.sent.filter((m) => m.method === 'tools/call').length,
    2,
    'the same process',
  )
})

// --- Notifications, and anything that is no request ---

test('a notification goes to every server; a response to none', async () => {
  const { open, servers } = combine({ a: {}, b: {} })
  const { child, said } = open()
  await child.send({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 1 },
  } as never)
  await child.finish()
  for (const server of [servers.a, servers.b]) {
    assert.deepEqual(server.methods(), ['notifications/cancelled'])
    assert.equal(server.instances[0].finished, true)
  }
  await child.send({ jsonrpc: '2.0', id: 9, result: {} } as never)
  await child.finish()
  assert.deepEqual(said, [])
  assert.equal(servers.a.instances.length, 1)
})

// --- Failure and the end of the request ---

test("the request's server failing or stopping fails the request, once, and stops every server started for it", async () => {
  for (const how of ['error', 'close'] as const) {
    const { open, servers, errors } = combine({
      a: { tools: ['x'], answers: { 'tools/call': () => 'hold' } },
      b: { tools: ['y'] },
    })
    const { child, failures, closes, request } = open()
    void request('tools/call', { name: 'x' })
    await new Promise((resolve) => setImmediate(resolve))
    const server = servers.a.instances.at(-1)!
    if (how === 'error') server.child.onerror!(Error('boom'))
    else server.child.onclose!()
    assert.deepEqual(failures, [
      how === 'error' ? 'boom' : 'Server "a" stopped',
    ])
    assert.equal(errors.at(-1)![0], 'tools: request failed:')
    assert.equal(closes(), 1)
    await child.finish()
    for (const { instances } of Object.values(servers))
      for (const instance of instances) assert.equal(instance.closed, true)
    // Stopped already: nothing more is reported, or sent.
    await child.close()
    assert.equal(closes(), 1)
    await assert.rejects(
      child.send({ jsonrpc: '2.0', id: 3, method: 'tools/list' } as never),
      /The request is closed/,
    )
  }
})

test('a server that dies while it is asked for the request fails it', async () => {
  const { open } = combine({
    a: { answers: { 'server/discover': () => 'die' } },
  })
  const { failures, request } = open()
  assert.equal(await request('server/discover'), undefined)
  assert.deepEqual(failures, ['a died'])
})

// --- Whether the entry speaks it ---

test('an entry speaks 2026-07-28 when every server does', async () => {
  const { entry, servers, logger, info } = combine({
    a: {},
    b: { versions: ['2025-11-25', MODERN_VERSION] },
  })
  assert.equal(await combinedSpeaksModern(entry, logger)(), true)
  assert.deepEqual(info, ['tools: every server speaks 2026-07-28'])
  // Each was started, asked and stopped.
  for (const server of [servers.a, servers.b]) {
    assert.deepEqual(server.methods(), ['server/discover'])
    assert.equal(server.instances[0].started, true)
    assert.equal(server.instances[0].closed, true)
    assert.deepEqual(server.instances[0].declared, {
      version: MODERN_VERSION,
      params: {},
    })
  }
})

test('one server that does not makes the entry answer the earlier versions', async () => {
  const cases: [string, Spec][] = [
    ['other versions', { versions: ['2025-11-25'] }],
    [
      'an error',
      {
        answers: {
          'server/discover': () => ({ error: { code: -32601, message: 'x' } }),
        },
      },
    ],
    ['a failure', { answers: { 'server/discover': () => 'die' } }],
    ['no such requests', { none: true }],
  ]
  for (const [name, spec] of cases) {
    const { entry, logger, info } = combine({
      fine: {},
      old: spec,
      older: spec,
    })
    assert.equal(await combinedSpeaksModern(entry, logger)(), false, name)
    assert.deepEqual(
      info,
      [
        'tools: "old", "older" do not speak 2026-07-28, so the entry answers the earlier versions',
      ],
      name,
    )
  }
})

test('a server that never answers is one that does not speak it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { entry, logger } = combine({
    silent: { answers: { 'server/discover': () => 'hold' } },
  })
  const speaks = combinedSpeaksModern(entry, logger)()
  await new Promise((resolve) => setImmediate(resolve))
  t.mock.timers.tick(10_000)
  assert.equal(await speaks, false)
})

test('the answer stands for a minute', async () => {
  let now = 1000
  const { entry, servers, logger } = combine({ a: {} })
  const speaks = combinedSpeaksModern(entry, logger, () => now)
  assert.deepEqual(await Promise.all([speaks(), speaks()]), [true, true])
  now += SPEAKS_FOR_MS - 1
  await speaks()
  assert.equal(servers.a.instances.length, 1)
  now += 1
  await speaks()
  assert.equal(servers.a.instances.length, 2)
})

// --- Edges ---

test("what a server says besides the answer to the gateway's own request is not taken for it", async () => {
  const { request } = combine({
    a: {
      tools: ['x'],
      noise: [
        {
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { data: 'hi' },
        },
        { jsonrpc: '2.0', id: 'supergateway-1', method: 'roots/list' },
        {
          jsonrpc: '2.0',
          id: 'someone-else',
          result: { tools: [{ name: 'wrong' }] },
        },
      ],
    },
  })
  assert.deepEqual(names((await request('tools/list'))!.result.tools), ['x'])
})

test('a server that stops while it is asked for a list is left out of it', async () => {
  const { request, errors } = combine({
    stops: { answers: { 'tools/list': () => 'close' } },
    fine: { tools: ['ok'] },
  })
  assert.deepEqual(names((await request('tools/list'))!.result.tools), ['ok'])
  assert.deepEqual(errors, [
    ['tools: tools/list of server "stops" failed: The server stopped'],
  ])
})

test('requests with no params at all are placed, or refused, like any other', async () => {
  const { open } = combine({ a: { tools: ['x'], prompts: ['p'] } })
  const raw = async (method: string) => {
    const { child, said } = open()
    await child.send({ jsonrpc: '2.0', id: 1, method } as never)
    await child.finish()
    return said[0]
  }
  assert.deepEqual(names((await raw('tools/list')).result.tools), ['x'])
  assert.equal(
    (await raw('tools/call')).error.message,
    'Unknown tool: undefined',
  )
  assert.equal((await raw('completion/complete')).error.code, -32002)
  assert.equal((await raw('resources/read')).error.code, -32002)
})

test('a discover answer that is neither a result nor an error fails it', async () => {
  const { request } = combine({
    odd: { answers: { 'server/discover': () => ({}) } },
  })
  assert.deepEqual((await request('server/discover'))!.error, {
    code: -32603,
    message: 'Server "odd" failed: undefined',
  })
})

test('with no one listening, answers and failures go nowhere, and nothing throws', async () => {
  const { entry, logger, errors, servers } = combine({
    a: {
      tools: ['x'],
      answers: { 'server/discover': () => 'die', 'tools/call': () => 'hold' },
    },
  })
  const fresh = () =>
    new CombinedModernChild(
      entry,
      { version: MODERN_VERSION, params: {} },
      logger,
    )
  const send = async (
    child: CombinedModernChild,
    method: string,
    params = {},
  ) => {
    await child.send({
      jsonrpc: '2.0',
      id: 1,
      method,
      params: { _meta: meta, ...params },
    } as never)
    await child.finish()
  }
  // A result, a refusal, and a failure.
  await send(fresh(), 'tools/list')
  await send(fresh(), 'tools/call', { name: 'nope' })
  await send(fresh(), 'server/discover')
  assert.equal(errors.at(-1)![0], 'tools: request failed:')
  // What the request's own server says, too.
  const passed = fresh()
  await send(passed, 'tools/call', { name: 'x' })
  servers.a.instances.at(-1)!.child.onmessage!({
    jsonrpc: '2.0',
    id: 1,
    result: {},
  } as never)
})

test('a send that fails because the request was closed is not reported', async () => {
  const { open, servers, errors } = combine({
    a: { tools: ['x'], hangSend: true },
  })
  const { child, failures, request } = open()
  await request('tools/list', {}, 1)
  await child.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { _meta: meta, name: 'x' },
  } as never)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(servers.a.instances.at(-1)!.sent.at(-1)!.method, 'tools/call')
  const before = errors.length
  await child.close()
  await child.finish()
  assert.deepEqual(failures, [])
  assert.equal(errors.length, before)
})
