import { test } from 'node:test'
import assert from 'node:assert/strict'
import { combinedPeer } from '../src/lib/combinedPeer.js'
import { getVersion } from '../src/lib/getVersion.js'
import {
  fakeClient,
  fakeServer,
  settled,
  type FakeServerSpec,
} from './helpers/fake-mcp-peer.js'

// Several servers combined on one URL, as one session sees them. The servers
// are in memory, so the test decides when each answers, fails or exits.

const logs = () => {
  const errors: string[] = []
  return {
    errors,
    logger: { info: () => {}, error: (line: string) => errors.push(line) },
  }
}

// A session of `specs`, by name in config order, and its client.
const combine = (specs: Record<string, FakeServerSpec>) => {
  const servers = Object.entries(specs).map(([name, spec]) =>
    fakeServer(name, spec),
  )
  const { errors, logger } = logs()
  const client = fakeClient(combinedPeer('tools', servers, logger))
  const byName = Object.fromEntries(servers.map((s) => [s.name, s]))
  return { client, errors, servers: byName }
}

const result = async (answer: Promise<Record<string, any>>) =>
  (await answer).result
const error = async (answer: Promise<Record<string, any>>) =>
  (await answer).error
const names = (items: { name: string }[]) => items.map((item) => item.name)

// --- initialize ---

test('initialize is answered as one server: union of capabilities, instructions by name', async () => {
  const { client, servers, errors } = combine({
    git: {
      capabilities: { tools: { listChanged: true }, logging: {}, tasks: {} },
      instructions: 'Use git carefully.',
    },
    files: {
      capabilities: {
        tools: {},
        resources: { subscribe: true },
        experimental: { x: { deep: true } },
      },
    },
    docs: {
      capabilities: { resources: { listChanged: true }, prompts: {} },
      instructions: 'Docs are read-only.',
    },
  })
  assert.deepEqual(await result(client.initialize()), {
    protocolVersion: '2025-06-18',
    capabilities: {
      tools: { listChanged: true },
      logging: {},
      resources: { subscribe: true, listChanged: true },
      experimental: { x: { deep: true } },
      prompts: {},
    },
    serverInfo: { name: 'supergateway', title: 'tools', version: getVersion() },
    instructions:
      '## git\n\nUse git carefully.\n\n## docs\n\nDocs are read-only.',
  })
  // Each got the client's own initialize, then initialized from the gateway.
  for (const server of Object.values(servers)) {
    assert.deepEqual(server.methods(), [
      'initialize',
      'notifications/initialized',
    ])
    assert.deepEqual(server.received()[0].params, {
      protocolVersion: '2025-06-18',
      capabilities: { sampling: {} },
      clientInfo: { name: 'test', version: '1' },
    })
  }
  // The client's own initialized is not passed on a second time.
  client.notify('notifications/initialized')
  assert.equal(servers.git.methods().length, 2)
  assert.deepEqual(errors, [])
})

test('without instructions there are none; capabilities that are not objects are none', async () => {
  const { client } = combine({
    a: {
      answers: {
        initialize: () => ({
          result: { protocolVersion: '2025-06-18', capabilities: 'yes' },
        }),
      },
    },
  })
  const answer = await result(client.initialize())
  assert.equal('instructions' in answer, false)
  assert.deepEqual(answer.capabilities, {})
})

test('ping is answered by the gateway, before and after initialize', async () => {
  const { client, servers } = combine({ a: {} })
  assert.deepEqual(await result(client.request('ping')), {})
  await client.initialize()
  assert.deepEqual(await result(client.request('ping')), {})
  assert.deepEqual(servers.a.methods(), [
    'initialize',
    'notifications/initialized',
  ])
})

test('a request before initialize, and a second initialize, are refused', async () => {
  const { client } = combine({ a: { tools: ['x'] } })
  assert.deepEqual(await error(client.request('tools/list')), {
    code: -32600,
    message: 'The session is not initialized',
  })
  await client.initialize()
  assert.deepEqual(await error(client.initialize()), {
    code: -32600,
    message: 'The session is already initialized',
  })
})

test('a request sent while initialize is under way waits for it', async () => {
  const { client } = combine({ a: { tools: ['x'] } })
  const initialized = client.initialize()
  const listed = client.request('tools/list')
  await initialized
  assert.deepEqual(names((await result(listed)).tools), ['x'])
})

test("the lowest version any server answers is the session's, and the others start again at it", async () => {
  const { client, servers, errors } = combine({
    old: { versions: ['2024-11-05'], tools: ['a'] },
    both: { versions: ['2024-11-05', '2025-06-18'], tools: ['b'] },
    newOnly: { versions: ['2025-06-18'], tools: ['c'] },
  })
  const answer = await result(client.initialize('2025-06-18'))
  assert.equal(answer.protocolVersion, '2024-11-05')
  // `both` answered 2025-06-18 first, was stopped and started again.
  assert.equal(servers.both.instances.length, 2)
  assert.equal(servers.both.instances[0].stopped, true)
  assert.equal(servers.both.received()[0].params.protocolVersion, '2024-11-05')
  assert.deepEqual(servers.both.methods(), [
    'initialize',
    'notifications/initialized',
  ])
  // `newOnly` can't speak it, and is left out; nothing is translated.
  assert.equal(servers.newOnly.instances.length, 2)
  assert.equal(servers.newOnly.instances[1].stopped, true)
  assert.deepEqual(errors, [
    'tools: server "newOnly" is left out of this session: it speaks 2025-06-18, and the others 2024-11-05',
  ])
  assert.deepEqual(names((await result(client.request('tools/list'))).tools), [
    'a',
    'b',
  ])
})

test('a server that fails or refuses at initialize is left out; the rest serve', async () => {
  const { client, servers, errors } = combine({
    refuses: {
      answers: {
        initialize: () => ({ error: { code: -32000, message: 'no' } }),
      },
    },
    exits: { answers: { initialize: () => 'hold' } },
    fails: { answers: { initialize: () => 'hold' } },
    fine: { tools: ['ok'] },
  })
  const initialized = client.initialize()
  await settled()
  servers.exits.exit(3)
  servers.fails.fail('upstream', 'fetch failed')
  assert.deepEqual((await result(initialized)).capabilities, { tools: {} })
  assert.deepEqual(errors, [
    'tools: server "refuses" is left out of this session: no',
    'tools: server "exits" is left out of this session: it exited, code=3, signal=null',
    'tools: server "fails" is left out of this session: upstream failure: fetch failed',
  ])
  assert.equal(servers.refuses.instances[0].stopped, true)
  assert.deepEqual(names((await result(client.request('tools/list'))).tools), [
    'ok',
  ])
  assert.deepEqual(client.exits, [])
})

test('when no server starts, initialize fails and the session ends', async () => {
  const { client, servers } = combine({
    a: { answers: { initialize: () => 'hold' } },
    b: {
      answers: { initialize: () => ({ error: { code: -1, message: 'x' } }) },
    },
  })
  const initialized = client.initialize()
  await settled()
  servers.a.exit(1)
  assert.deepEqual(await error(initialized), {
    code: -32603,
    message: 'No server of "tools" started',
  })
  assert.deepEqual(client.exits, [[null, null]])
  assert.equal(client.peer.gone, true)
})

// --- Lists ---

test("a list is every server's, all pages, in config order, as one page", async () => {
  const { client, servers } = combine({
    paged: { toolPages: [['a', 'b'], ['c'], ['d']] },
    none: { prompts: ['p'] },
    plain: { tools: ['e'] },
  })
  await client.initialize()
  assert.deepEqual(await result(client.request('tools/list')), {
    tools: ['a', 'b', 'c', 'd', 'e'].map((name) => ({ name })),
  })
  // Only servers that declared tools are asked.
  assert.equal(servers.none.methods().includes('tools/list'), false)
  assert.deepEqual(
    servers.paged
      .received()
      .filter((m) => m.method === 'tools/list')
      .map((m) => m.params),
    [{}, { cursor: '1' }, { cursor: '2' }],
  )
  assert.deepEqual(await error(client.request('tools/list', { cursor: 'x' })), {
    code: -32602,
    message: 'Invalid cursor',
  })
})

test('prompts, resources and templates are merged the same way', async () => {
  const { client } = combine({
    a: { prompts: ['p1'], resources: ['file:///a'], templates: ['a://{id}'] },
    b: { prompts: ['p2'], resources: ['file:///b'], templates: ['b://{id}'] },
  })
  await client.initialize()
  assert.deepEqual(await result(client.request('prompts/list')), {
    prompts: [{ name: 'p1' }, { name: 'p2' }],
  })
  assert.deepEqual(await result(client.request('resources/list')), {
    resources: [{ uri: 'file:///a' }, { uri: 'file:///b' }],
  })
  assert.deepEqual(await result(client.request('resources/templates/list')), {
    resourceTemplates: [
      { uriTemplate: 'a://{id}' },
      { uriTemplate: 'b://{id}' },
    ],
  })
})

test("a name two servers offer is the first listed one's, with one warning", async () => {
  const { client, servers, errors } = combine({
    first: { tools: ['search', 'only-first'], prompts: ['hello'] },
    second: { tools: ['search', 'only-second'], prompts: ['hello'] },
  })
  await client.initialize()
  assert.deepEqual(names((await result(client.request('tools/list'))).tools), [
    'search',
    'only-first',
    'only-second',
  ])
  await client.request('tools/list')
  await client.request('prompts/list')
  assert.deepEqual(errors, [
    'tools: tool "search" is offered by "first" and "second"; clients get the one of "first", listed first. Set "toolPrefix" on one of them to keep both',
    'tools: prompt "hello" is offered by "first" and "second"; clients get the one of "first", listed first',
  ])
  const called = await result(
    client.request('tools/call', { name: 'search', arguments: {} }),
  )
  assert.equal(called.content[0].text, 'first ran search')
  assert.equal(servers.second.methods().includes('tools/call'), false)
})

test('a server whose list fails, repeats a cursor or is no list still leaves the others', async () => {
  const { client, errors } = combine({
    broken: {
      capabilities: { tools: {} },
      answers: {
        'tools/list': () => ({ error: { code: -1, message: 'boom' } }),
      },
    },
    loops: {
      capabilities: { tools: {} },
      answers: {
        'tools/list': () => ({
          result: { tools: [{ name: 'again' }], nextCursor: 'same' },
        }),
      },
    },
    odd: {
      capabilities: { tools: {} },
      answers: { 'tools/list': () => ({ result: { tools: 'none' } }) },
    },
    unnamed: {
      capabilities: { tools: {} },
      answers: {
        'tools/list': () => ({ result: { tools: [{ title: 'x' }, null] } }),
      },
    },
    fine: { tools: ['ok'] },
  })
  await client.initialize()
  assert.deepEqual((await result(client.request('tools/list'))).tools, [
    // Asked once more with the cursor, then no further.
    { name: 'again' },
    { title: 'x' },
    null,
    { name: 'ok' },
  ])
  assert.deepEqual(errors, [
    'tools: tools/list of server "broken" failed: boom',
    'tools: tool "again" is offered by "loops" and "loops"; clients get the one of "loops", listed first. Set "toolPrefix" on one of them to keep both',
  ])
})

// --- Requests for one server ---

test('a call goes to the server with the tool, without a list first', async () => {
  const { client, servers } = combine({
    a: { tools: ['one'] },
    b: { tools: ['two'], prompts: ['greet'] },
  })
  await client.initialize()
  const called = await client.request('tools/call', { name: 'two' }, 'call-1')
  // The server's own answer, under the client's id, as it wrote it.
  assert.deepEqual(called, {
    jsonrpc: '2.0',
    id: 'call-1',
    result: { content: [{ type: 'text', text: 'b ran two' }] },
  })
  assert.equal(client.lines.at(-1), JSON.stringify(called))
  assert.equal(servers.a.methods().includes('tools/call'), false)
  assert.deepEqual(
    await result(client.request('prompts/get', { name: 'greet' })),
    { description: 'b: greet' },
  )
})

test('a name no server has is refused, after one more look', async () => {
  let tools = ['old']
  const { client, servers } = combine({
    a: {
      capabilities: { tools: {}, prompts: {} },
      answers: {
        'tools/list': () => ({
          result: { tools: tools.map((name) => ({ name })) },
        }),
      },
    },
  })
  await client.initialize()
  await client.request('tools/list')
  // Added since the list: found by looking again.
  tools = ['old', 'new']
  assert.equal(
    (await result(client.request('tools/call', { name: 'new' }))).content[0]
      .text,
    'a ran new',
  )
  assert.deepEqual(
    await error(client.request('tools/call', { name: 'nope' })),
    {
      code: -32602,
      message: 'Unknown tool: nope',
    },
  )
  assert.deepEqual(await error(client.request('tools/call')), {
    code: -32602,
    message: 'Unknown tool: undefined',
  })
  assert.deepEqual(await error(client.request('prompts/get', { name: 'x' })), {
    code: -32602,
    message: 'Unknown prompt: x',
  })
  assert.equal(servers.a.methods().includes('prompts/get'), false)
})

test('a resource goes to the server that lists it, or whose template it fits', async () => {
  const { client } = combine({
    files: { resources: ['file:///etc/hosts'], templates: ['file:///{path}'] },
    db: {
      resources: ['db://users'],
      templates: [
        'db://{table}/{id}',
        'db://search{?q,limit}',
        'db://raw/{+rest}',
      ],
    },
  })
  await client.initialize()
  const reader = async (uri: string) =>
    (await result(client.request('resources/read', { uri }))).contents[0].text
  assert.equal(await reader('db://users'), 'db')
  assert.equal(await reader('file:///etc/hosts'), 'files')
  assert.equal(await reader('db://orders/7'), 'db')
  assert.equal(await reader('db://search?q=a&limit=2'), 'db')
  assert.equal(await reader('db://raw/a/b/c'), 'db')
  assert.equal(await reader('file:///notes.txt'), 'files')
  // A simple expression does not cross a path segment.
  assert.deepEqual(
    await error(client.request('resources/read', { uri: 'file:///a/b.txt' })),
    {
      code: -32002,
      message: 'Resource not found',
      data: { uri: 'file:///a/b.txt' },
    },
  )
  assert.deepEqual(
    await result(client.request('resources/subscribe', { uri: 'db://users' })),
    {},
  )
  assert.deepEqual(
    await result(
      client.request('resources/unsubscribe', { uri: 'db://users' }),
    ),
    {},
  )
  assert.deepEqual((await error(client.request('resources/read'))).code, -32002)
})

test('a completion goes by what it refers to', async () => {
  const { client } = combine({
    a: { prompts: ['greet'] },
    b: { templates: ['b://{id}'] },
  })
  await client.initialize()
  const complete = async (ref: unknown) =>
    await client.request('completion/complete', { ref, argument: {} })
  assert.deepEqual(
    (await complete({ type: 'ref/prompt', name: 'greet' })).result,
    {
      completion: { values: ['a'] },
    },
  )
  // A client completes a template by the template itself.
  assert.deepEqual(
    (await complete({ type: 'ref/resource', uri: 'b://{id}' })).result,
    {
      completion: { values: ['b'] },
    },
  )
  assert.equal((await complete(undefined)).error.code, -32002)
})

test('logging/setLevel goes to every server that logs', async () => {
  const { client, servers, errors } = combine({
    logs: { capabilities: { logging: {} } },
    refuses: {
      capabilities: { logging: {} },
      answers: {
        'logging/setLevel': () => ({ error: { code: -1, message: 'no' } }),
      },
    },
    quiet: { tools: ['x'] },
  })
  await client.initialize()
  assert.deepEqual(
    await result(client.request('logging/setLevel', { level: 'debug' })),
    {},
  )
  assert.deepEqual(servers.logs.received().at(-1)!.params, { level: 'debug' })
  assert.equal(servers.quiet.methods().includes('logging/setLevel'), false)
  assert.deepEqual(errors, [
    'tools: logging/setLevel of server "refuses" failed: no',
  ])
})

test('a method the gateway cannot place is not found', async () => {
  const { client } = combine({ a: {} })
  await client.initialize()
  assert.deepEqual(await error(client.request('custom/thing')), {
    code: -32601,
    message: 'Method not found: custom/thing',
  })
})

// --- Notifications from the client ---

test('a cancellation goes to the server doing the request; others to every server', async () => {
  const { client, servers } = combine({
    slow: { tools: ['wait'], answers: { 'tools/call': () => 'hold' } },
    other: { tools: ['x'] },
  })
  await client.initialize()
  await client.request('tools/list')
  void client.request('tools/call', { name: 'wait' }, 'slow-1')
  await settled()
  client.notify('notifications/cancelled', { requestId: 'slow-1' })
  client.notify('notifications/cancelled', { requestId: 'unknown' })
  client.notify('notifications/roots/list_changed')
  client.notify('notifications/progress', {
    progressToken: 'not-ours',
    progress: 1,
  })
  assert.deepEqual(servers.slow.methods().slice(-4), [
    'tools/call',
    'notifications/cancelled',
    'notifications/roots/list_changed',
    'notifications/progress',
  ])
  assert.deepEqual(servers.other.methods().slice(-2), [
    'notifications/roots/list_changed',
    'notifications/progress',
  ])
})

test('a batch from the client is taken message by message', async () => {
  const { client } = combine({ a: { tools: ['x'] } })
  await client.initialize()
  client.peer.write([
    { jsonrpc: '2.0', id: 'p', method: 'ping' },
    { jsonrpc: '2.0', id: 'l', method: 'tools/list' },
  ] as any)
  await settled()
  assert.deepEqual(
    client.told
      .slice(-2)
      .map((message) => message.id)
      .sort(),
    ['l', 'p'],
  )
})

// --- From the servers ---

test("a server's request reaches the client under the gateway's id, and the answer goes back under its own", async () => {
  const { client, servers } = combine({ a: {}, b: {} })
  await client.initialize()
  servers.a.say({
    jsonrpc: '2.0',
    id: 1,
    method: 'sampling/createMessage',
    params: { messages: [] },
  })
  servers.b.say({
    jsonrpc: '2.0',
    id: 1,
    method: 'roots/list',
    params: { _meta: { progressToken: 't', other: 1 } },
  })
  assert.deepEqual(client.unasked(), [
    {
      jsonrpc: '2.0',
      id: 'sgw:a:1',
      method: 'sampling/createMessage',
      params: { messages: [] },
    },
    {
      jsonrpc: '2.0',
      id: 'sgw:b:2',
      method: 'roots/list',
      params: { _meta: { progressToken: 'sgw:b:2:progress', other: 1 } },
    },
  ])
  // Progress for the server's request reaches it under its own token.
  client.notify('notifications/progress', {
    progressToken: 'sgw:b:2:progress',
    progress: 5,
  })
  assert.deepEqual(servers.b.received().at(-1), {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 't', progress: 5 },
  })
  assert.equal(servers.a.methods().includes('notifications/progress'), false)

  client.peer.write({
    jsonrpc: '2.0',
    id: 'sgw:b:2',
    result: { roots: [] },
  } as any)
  client.peer.write({
    jsonrpc: '2.0',
    id: 'sgw:a:1',
    error: { code: -1, message: 'denied' },
  } as any)
  assert.deepEqual(servers.b.received().at(-1), {
    jsonrpc: '2.0',
    id: 1,
    result: { roots: [] },
  })
  assert.deepEqual(servers.a.received().at(-1), {
    jsonrpc: '2.0',
    id: 1,
    error: { code: -1, message: 'denied' },
  })
  // Answered once: again, or an answer to nothing, goes nowhere.
  const before = servers.b.received().length
  client.peer.write({ jsonrpc: '2.0', id: 'sgw:b:2', result: {} } as any)
  client.peer.write({ jsonrpc: '2.0', id: 'never', result: {} } as any)
  assert.equal(servers.b.received().length, before)
  // Its token is forgotten with it: progress now goes to every server.
  client.notify('notifications/progress', {
    progressToken: 'sgw:b:2:progress',
    progress: 6,
  })
  assert.equal(servers.a.methods().at(-1), 'notifications/progress')
})

test('a server cancelling its own request names it as the client knows it', async () => {
  const { client, servers } = combine({ a: {} })
  await client.initialize()
  servers.a.say({
    jsonrpc: '2.0',
    id: 9,
    method: 'elicitation/create',
    params: {},
  })
  servers.a.say({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 9, reason: 'late' },
  })
  servers.a.say({
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 'never sent' },
  })
  assert.deepEqual(client.unasked().slice(1), [
    {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'sgw:a:1', reason: 'late' },
    },
  ])
  // The client's late answer to it goes nowhere.
  const before = servers.a.received().length
  client.peer.write({ jsonrpc: '2.0', id: 'sgw:a:1', result: {} } as any)
  assert.equal(servers.a.received().length, before)
})

test('a log message says which server; other notifications pass as they are', async () => {
  const { client, servers } = combine({ git: {} })
  await client.initialize()
  servers.git.say({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: 'x' },
  })
  servers.git.say({
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', logger: 'http', data: 'y' },
  })
  const progress = {
    jsonrpc: '2.0',
    method: 'notifications/progress',
    params: { progressToken: 1, progress: 2 },
  }
  servers.git.say(progress)
  assert.deepEqual(client.unasked(), [
    {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'x', logger: 'git' },
    },
    {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', logger: 'git/http', data: 'y' },
    },
    progress,
  ])
  assert.equal(client.lines.at(-1), JSON.stringify(progress))
})

test('a list that changed is announced, and looked at again for the next call', async () => {
  let tools = ['a']
  const { client, servers } = combine({
    s: {
      capabilities: { tools: { listChanged: true } },
      answers: {
        'tools/list': () => ({
          result: { tools: tools.map((name) => ({ name })) },
        }),
      },
    },
  })
  await client.initialize()
  await client.request('tools/list')
  tools = ['b']
  servers.s.say({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
  assert.deepEqual(client.unasked(), [
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
  ])
  const lists = () =>
    servers.s.methods().filter((m) => m === 'tools/list').length
  const before = lists()
  await client.request('tools/call', { name: 'b' })
  assert.equal(lists(), before + 1, 'the table was dropped, so fetched once')
})

test('a batch, or an answer to nothing, from a server', async () => {
  const { client, servers } = combine({ a: { tools: ['x'] } })
  await client.initialize()
  servers.a.say([
    {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'u' },
    },
    { jsonrpc: '2.0', id: 'nobody', result: {} },
  ] as any)
  assert.deepEqual(client.unasked(), [
    {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'u' },
    },
  ])
  assert.equal(
    client.told.some((message) => message.id === 'nobody'),
    false,
  )
})

test('what a server prints besides MCP is passed on under its name', async () => {
  const { client, servers } = combine({ git: {} })
  await client.initialize()
  const { owner } = servers.git.instances[0]
  owner.nonJson('starting')
  owner.stderr('warn: x')
  assert.equal(owner.output(), undefined)
  assert.deepEqual(client.other, [
    ['nonJson', '[git] starting'],
    ['stderr', '[git] warn: x'],
  ])
})

// --- A server that stops ---

test('a server that stops fails what it was asked, and the client is told its lists changed', async () => {
  const { client, servers, errors } = combine({
    dies: {
      capabilities: { tools: {}, resources: {} },
      tools: ['doomed'],
      answers: { 'tools/call': () => 'hold' },
    },
    stays: { tools: ['fine'], prompts: ['p'] },
  })
  await client.initialize()
  const pending = client.request('tools/call', { name: 'doomed' }, 'd1')
  await settled()
  servers.dies.say({ jsonrpc: '2.0', id: 4, method: 'roots/list' })
  servers.dies.exit(137, 'SIGKILL')
  assert.deepEqual(await error(pending), {
    code: -32603,
    message: 'MCP server "dies" failed',
  })
  assert.deepEqual(client.unasked().slice(1), [
    {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: 'sgw:dies:1', reason: 'MCP server "dies" failed' },
    },
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    { jsonrpc: '2.0', method: 'notifications/resources/list_changed' },
  ])
  assert.deepEqual(errors, [
    'tools: server "dies" stopped: it exited, code=137, signal=SIGKILL',
  ])
  // The session goes on with the rest; the dead one's tools are unknown.
  assert.deepEqual(names((await result(client.request('tools/list'))).tools), [
    'fine',
  ])
  assert.equal(
    (await error(client.request('tools/call', { name: 'doomed' }))).code,
    -32602,
  )
  assert.deepEqual(client.exits, [])
  // Told once: its exit after a failure changes nothing.
  servers.dies.instances[0].owner.failure('process', Error('again'))
  servers.dies.instances[0].owner.message(
    { jsonrpc: '2.0', method: 'notifications/tools/list_changed' },
    '',
  )
  assert.equal(errors.length, 1)
  assert.equal(client.unasked().length, 4)
})

test('the session ends when its last server does, with that exit', async () => {
  const { client, servers } = combine({ a: { tools: ['x'] }, b: {} })
  await client.initialize()
  servers.a.fail('stdin', 'write EPIPE')
  assert.deepEqual(client.exits, [])
  assert.equal(client.peer.gone, false)
  servers.b.exit(null, 'SIGTERM')
  assert.deepEqual(client.exits, [[null, 'SIGTERM']])
  assert.equal(client.peer.gone, true)
  // With no server, a list is empty and a call finds nothing.
  assert.deepEqual(await result(client.request('tools/list')), { tools: [] })
})

test('a server that stops while a list is fetched does not get the calls for it', async () => {
  let lists = 0
  const { client, servers } = combine({
    dies: { tools: ['gone-soon'] },
    slow: {
      capabilities: { tools: {} },
      // The first list waits for the test; later ones are answered.
      answers: {
        'tools/list': () =>
          ++lists === 1
            ? 'hold'
            : { result: { tools: [{ name: 'slow-tool' }] } },
      },
    },
  })
  await client.initialize()
  const listed = client.request('tools/list')
  await settled()
  // `dies` has answered its list; it stops before `slow` answers.
  servers.dies.exit(1)
  const request = servers.slow.received().at(-1)!
  servers.slow.say({
    jsonrpc: '2.0',
    id: request.id,
    result: { tools: [{ name: 'slow-tool' }] },
  })
  assert.deepEqual(names((await result(listed)).tools), [
    'gone-soon',
    'slow-tool',
  ])
  assert.deepEqual(
    await error(client.request('tools/call', { name: 'gone-soon' })),
    { code: -32602, message: 'Unknown tool: gone-soon' },
  )
})

test('a server stopping during initialize, after it answered, is not announced', async () => {
  const { client, servers } = combine({
    answered: { tools: ['x'] },
    slow: { answers: { initialize: () => 'hold' }, tools: ['y'] },
  })
  const initialized = client.initialize()
  await settled()
  servers.answered.exit(1)
  const request = servers.slow.received()[0]
  servers.slow.say({
    jsonrpc: '2.0',
    id: request.id,
    result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
  })
  assert.deepEqual((await result(initialized)).capabilities, { tools: {} })
  assert.deepEqual(client.unasked(), [])
})

// --- The session's own end ---

test('end and stop reach every server still there', async () => {
  const { client, servers } = combine({ a: {}, b: {} })
  await client.initialize()
  servers.b.exit(0)
  client.peer.end()
  assert.equal(servers.a.instances[0].ended, true)
  assert.equal(servers.b.instances[0].ended, false)
  await client.peer.stop()
  assert.equal(servers.a.instances[0].stopped, true)
  assert.equal(client.peer.gone, true)
  // A server exiting because it was stopped is not a failure.
  servers.a.exit(0)
  assert.deepEqual(client.exits, [])
})

test('stopped before any initialize, there is nothing to stop', async () => {
  const { client } = combine({ a: {} })
  assert.equal(client.peer.gone, false)
  client.peer.end()
  await client.peer.stop()
  assert.equal(client.peer.gone, true)
})
