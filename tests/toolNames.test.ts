import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { ChildOwner, StartPeer } from '../src/lib/childHandoff.js'
import { ToolNames, toolNamesPeer } from '../src/lib/toolNames.js'

// --toolPrefix and --tools: what a client sees of a server's tools, and what
// the server is sent.

const logs = () => {
  const errors: string[] = []
  return {
    errors,
    logger: { info: () => {}, error: (line: string) => errors.push(line) },
  }
}

const names = (options: { toolPrefix?: string; tools?: string[] }) =>
  ToolNames.of(options, logs().logger)!

const call = (name: unknown, id: string | number = 1): JSONRPCMessage =>
  ({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: { a: 1 }, _meta: { progressToken: 'p' } },
  }) as JSONRPCMessage

test('neither option set rewrites nothing at all', () => {
  const { errors, logger } = logs()
  assert.equal(ToolNames.of({}, logger), undefined)
  assert.equal(ToolNames.of({ toolPrefix: '' }, logger), undefined)
  assert.deepEqual(errors, [])
})

test('an empty list of tools is a list: none of them', () => {
  const none = names({ tools: [] })
  assert.deepEqual(none.describe(), ['tools: (none)'])
  assert.deepEqual(none.listed({ tools: [{ name: 'a' }] }), { tools: [] })
})

test('the startup listing names what is set', () => {
  assert.deepEqual(names({ toolPrefix: 'gh_' }).describe(), ['toolPrefix: gh_'])
  assert.deepEqual(names({ tools: ['search', 'get'] }).describe(), [
    'tools: search, get',
  ])
  assert.deepEqual(names({ toolPrefix: 'gh_', tools: ['search'] }).describe(), [
    'toolPrefix: gh_',
    'tools: search',
  ])
})

test('a prefix a tool name cannot carry is warned about at start', () => {
  const { errors, logger } = logs()
  ToolNames.of({ toolPrefix: 'git hub/' }, logger)
  ToolNames.of({ toolPrefix: 'gh.v2-x_' }, logger)
  assert.deepEqual(errors, [
    'toolPrefix "git hub/" makes tool names a client may refuse: a tool name is letters, digits, "_", "-" and "." only',
  ])
})

test('a call by the listed name reaches the server under its own', () => {
  const gh = names({ toolPrefix: 'gh_' })
  assert.deepEqual(gh.inbound(call('gh_search')), {
    forward: {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: { a: 1 },
        _meta: { progressToken: 'p' },
      },
    },
  })
})

test('a call the client cannot see is answered with the unknown-tool error', () => {
  const unknown = (id: string | number, name: unknown) => ({
    reply: {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `Unknown tool: ${name}` },
    },
  })
  const gh = names({ toolPrefix: 'gh_', tools: ['search'] })
  // Without the prefix, filtered out, or no name at all.
  assert.deepEqual(gh.inbound(call('search', 'a')), unknown('a', 'search'))
  assert.deepEqual(gh.inbound(call('gh_delete', 2)), unknown(2, 'gh_delete'))
  assert.deepEqual(gh.inbound(call(undefined, 3)), unknown(3, undefined))
  assert.deepEqual(gh.inbound(call(7, 4)), unknown(4, 7))
  // A filter alone needs no prefix.
  const only = names({ tools: ['search'] })
  assert.equal('forward' in only.inbound(call('search')), true)
  assert.deepEqual(only.inbound(call('delete')), unknown(1, 'delete'))
})

test('everything but a tools/call request passes as it is', () => {
  const gh = names({ toolPrefix: 'gh_', tools: [] })
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'x' } },
    { jsonrpc: '2.0', method: 'tools/call', params: { name: 'x' } },
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: {} },
    { jsonrpc: '2.0', id: 3, result: {} },
  ] as JSONRPCMessage[]
  for (const message of messages)
    assert.equal((gh.inbound(message) as { forward: unknown }).forward, message)
})

test('a list shows the allowed tools, prefixed, and keeps everything else', () => {
  const gh = names({ toolPrefix: 'gh_', tools: ['search', 'get'] })
  const listed = gh.listed({
    tools: [
      { name: 'search', description: 'd', inputSchema: { type: 'object' } },
      { name: 'delete' },
      { name: 'get', _meta: { k: 1 } },
      null,
      { description: 'no name' },
    ],
    nextCursor: 'c',
    _meta: { m: 1 },
  })
  assert.deepEqual(listed, {
    tools: [
      { name: 'gh_search', description: 'd', inputSchema: { type: 'object' } },
      { name: 'gh_get', _meta: { k: 1 } },
    ],
    nextCursor: 'c',
    _meta: { m: 1 },
  })
})

test('without a filter, every tool is listed; one without a name as it is', () => {
  const gh = names({ toolPrefix: 'gh_' })
  assert.deepEqual(
    gh.listed({ tools: [{ name: 'a' }, { title: 'x' }, null] }),
    {
      tools: [{ name: 'gh_a' }, { title: 'x' }, null],
    },
  )
})

test('a result without a list of tools is left alone', () => {
  const gh = names({ toolPrefix: 'gh_' })
  const result = { tools: 'not a list' }
  assert.equal(gh.listed(result), result)
  const empty = {}
  assert.equal(gh.listed(empty), empty)
})

test('a prefixed name too long for clients is warned about once', () => {
  const { errors, logger } = logs()
  const gh = ToolNames.of({ toolPrefix: 'gh_' }, logger)!
  const long = 'x'.repeat(126)
  const list = { tools: [{ name: long }, { name: 'short' }] }
  assert.deepEqual(gh.listed(list).tools, [
    { name: `gh_${long}` },
    { name: 'gh_short' },
  ])
  gh.listed(list)
  assert.deepEqual(errors, [
    `Tool "gh_${long}" is not a valid tool name (letters, digits, "_", "-" and ".", at most 128); a client may refuse it`,
  ])
  // A filter alone adds nothing to a name, so warns about none.
  const filter = logs()
  ToolNames.of({ tools: [`${long}xyz`] }, filter.logger)!.listed({
    tools: [{ name: `${long}xyz` }],
  })
  assert.deepEqual(filter.errors, [])
})

// A peer that records what it was sent and lets the test answer.
function fakePeer() {
  const written: JSONRPCMessage[] = []
  const said: [unknown, string][] = []
  let inner!: ChildOwner
  let ends = 0
  let stops = 0
  let gone = false
  const start: StartPeer = (owner) => {
    inner = owner
    return {
      write: (message) => written.push(message),
      end: () => ends++,
      stop: async () => {
        stops++
      },
      get gone() {
        return gone
      },
    }
  }
  const owner: ChildOwner = {
    message: (message, line) => said.push([message, line]),
    nonJson: (line) => said.push(['nonJson', line]),
    stderr: (text) => said.push(['stderr', text]),
    failure: (kind) => said.push(['failure', kind]),
    exit: (code) => said.push(['exit', String(code)]),
    output: () => undefined,
  }
  return {
    start,
    owner,
    written,
    said,
    server: () => inner,
    counts: () => ({ ends, stops }),
    leave: () => {
      gone = true
    },
  }
}

test('a peer rewrites the answers to the tools/list requests it was sent', () => {
  const fake = fakePeer()
  const peer = toolNamesPeer(
    fake.start,
    names({ toolPrefix: 'gh_' }),
  )(fake.owner)
  peer.write({ jsonrpc: '2.0', id: 'l', method: 'tools/list', params: {} })
  assert.deepEqual(fake.written, [
    { jsonrpc: '2.0', id: 'l', method: 'tools/list', params: {} },
  ])
  fake
    .server()
    .message(
      { jsonrpc: '2.0', id: 'l', result: { tools: [{ name: 'a' }] } },
      'raw',
    )
  const answer = {
    jsonrpc: '2.0',
    id: 'l',
    result: { tools: [{ name: 'gh_a' }] },
  }
  assert.deepEqual(fake.said, [[answer, JSON.stringify(answer)]])

  // Answered once: the same id again is someone else's.
  fake
    .server()
    .message(
      { jsonrpc: '2.0', id: 'l', result: { tools: [{ name: 'b' }] } },
      'again',
    )
  assert.deepEqual(fake.said[1], [
    { jsonrpc: '2.0', id: 'l', result: { tools: [{ name: 'b' }] } },
    'again',
  ])
})

test('a peer passes everything else from the server as it is', () => {
  const fake = fakePeer()
  const peer = toolNamesPeer(
    fake.start,
    names({ toolPrefix: 'gh_' }),
  )(fake.owner)
  peer.write({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  peer.write({ jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} })
  const server = fake.server()
  const failed = { jsonrpc: '2.0', id: 1, error: { code: -1, message: 'no' } }
  const other = { jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'x' }] } }
  const request = { jsonrpc: '2.0', id: 1, method: 'roots/list' }
  const notification = {
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
  }
  for (const message of [failed, other, request, notification])
    server.message(message, 'line')
  server.nonJson('text')
  server.stderr('warn')
  server.failure('process', Error('x'))
  server.exit(1, null)
  assert.deepEqual(fake.said, [
    [failed, 'line'],
    [other, 'line'],
    [request, 'line'],
    [notification, 'line'],
    ['nonJson', 'text'],
    ['stderr', 'warn'],
    ['failure', 'process'],
    ['exit', '1'],
  ])
})

test('a peer answers a refused call itself, after write returns', async () => {
  const fake = fakePeer()
  const peer = toolNamesPeer(fake.start, names({ tools: ['ok'] }))(fake.owner)
  peer.write(call('secret', 9) as JSONRPCMessage)
  assert.deepEqual(fake.said, [], 'not inside write')
  await Promise.resolve()
  const reply = {
    jsonrpc: '2.0',
    id: 9,
    error: { code: -32602, message: 'Unknown tool: secret' },
  }
  assert.deepEqual(fake.said, [[reply, JSON.stringify(reply)]])
  assert.deepEqual(fake.written, [], 'the server never hears of it')
  peer.write(call('ok', 10) as JSONRPCMessage)
  assert.equal(
    (fake.written[0] as { params: { name: string } }).params.name,
    'ok',
  )
})

test('a peer ends, stops and goes as the server does', async () => {
  const fake = fakePeer()
  const peer = toolNamesPeer(fake.start, names({ tools: [] }))(fake.owner)
  peer.end()
  await peer.stop()
  assert.deepEqual(fake.counts(), { ends: 1, stops: 1 })
  assert.equal(peer.gone, false)
  fake.leave()
  assert.equal(peer.gone, true)
})

test('a batch is taken message by message, and stays a batch', async () => {
  const fake = fakePeer()
  const peer = toolNamesPeer(
    fake.start,
    names({ toolPrefix: 'gh_', tools: ['ok'] }),
  )(fake.owner)
  const list = { jsonrpc: '2.0', id: 'l', method: 'tools/list', params: {} }
  const note = { jsonrpc: '2.0', method: 'notifications/initialized' }
  // A refused call is answered; the rest goes on, renamed, as a batch.
  peer.write([
    list,
    call('gh_secret', 'refused'),
    call('gh_ok', 'allowed'),
    note,
  ] as unknown as JSONRPCMessage)
  assert.deepEqual(fake.written, [
    [
      list,
      {
        jsonrpc: '2.0',
        id: 'allowed',
        method: 'tools/call',
        params: {
          name: 'ok',
          arguments: { a: 1 },
          _meta: { progressToken: 'p' },
        },
      },
      note,
    ],
  ])
  await Promise.resolve()
  assert.deepEqual(
    fake.said.map(([message]) => message),
    [
      {
        jsonrpc: '2.0',
        id: 'refused',
        error: { code: -32602, message: 'Unknown tool: gh_secret' },
      },
    ],
  )

  // The server's batch answer: the list rewritten, the rest as it is.
  const done = { jsonrpc: '2.0', id: 'allowed', result: { content: [] } }
  fake.server().message(
    [
      {
        jsonrpc: '2.0',
        id: 'l',
        result: { tools: [{ name: 'ok' }, { name: 'secret' }] },
      },
      done,
    ],
    'raw',
  )
  const answer = [
    { jsonrpc: '2.0', id: 'l', result: { tools: [{ name: 'gh_ok' }] } },
    done,
  ]
  assert.deepEqual(fake.said[1], [answer, JSON.stringify(answer)])
})

test('a batch with nothing to change passes as it is, the same object', () => {
  const fake = fakePeer()
  const peer = toolNamesPeer(
    fake.start,
    names({ toolPrefix: 'gh_' }),
  )(fake.owner)
  const batch = [
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ] as unknown as JSONRPCMessage
  peer.write(batch)
  const empty = [] as unknown as JSONRPCMessage
  peer.write(empty)
  assert.equal(fake.written[0], batch)
  assert.equal(fake.written[1], empty)
  const answers = [{ jsonrpc: '2.0', id: 3, result: {} }]
  fake.server().message(answers, 'raw batch')
  assert.deepEqual(fake.said, [[answers, 'raw batch']])
})

test('a batch of refused calls sends the server nothing', async () => {
  const fake = fakePeer()
  const peer = toolNamesPeer(fake.start, names({ tools: [] }))(fake.owner)
  peer.write([call('a', 1), call('b', 2)] as unknown as JSONRPCMessage)
  await Promise.resolve()
  assert.deepEqual(fake.written, [])
  assert.deepEqual(
    fake.said.map(([message]) => (message as { id: number }).id),
    [1, 2],
  )
})
