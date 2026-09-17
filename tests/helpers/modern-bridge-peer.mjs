// A wire peer with observable process identity and deterministic faults.
// Legacy by default; safety tests opt into modern request envelopes.
// The separate SDK-backed fixture still supplies the real implementation control.
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { appendFileSync } from 'node:fs'
const mode = process.argv[2] ?? 'normal'
const trace = (event) => {
  if (process.env.MODERN_TRACE)
    appendFileSync(
      process.env.MODERN_TRACE,
      JSON.stringify({ pid: process.pid, ...event }) + '\n',
    )
}
trace({ event: 'start' })
if (mode === 'stubborn') {
  process.on('SIGTERM', () => {})
  const descendant = spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM',()=>{}); setInterval(()=>{},60000); process.send('ready')",
    ],
    { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] },
  )
  await once(descendant, 'message')
  trace({ event: 'descendant', descendantPid: descendant.pid })
}
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
let count = 0
const tool = (name, extra = {}) => ({
  name,
  inputSchema: { type: 'object', properties: {} },
  ...extra,
})
const tools = [
  tool('identity'),
  tool('wait'),
  tool('crash'),
  tool('reverse'),
  tool('echo', {
    title: 'Echo value',
    description: 'Echo with schema and metadata',
    annotations: { readOnlyHint: true },
    _meta: { custom: 'preserved' },
    inputSchema: {
      ...(process.env.MODERN_SCHEMA_REF
        ? { $ref: process.env.MODERN_SCHEMA_REF }
        : {}),
      type: 'object',
      properties: { value: { type: 'string', 'x-mcp-header': 'Value' } },
      required: ['value'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
  }),
]
let reverseId
for await (const line of readline.createInterface({ input: process.stdin })) {
  if (!line.trim()) continue
  const request = JSON.parse(line)
  trace({ event: 'message', message: request })
  const { method, params = {}, id } = request
  const modern =
    process.env.MODERN_WIRE === '1' &&
    params._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'
  const result = (result) =>
    send({
      jsonrpc: '2.0',
      id,
      result: {
        ...(modern
          ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
          : {}),
        ...result,
      },
    })
  const error = (code, message) =>
    send({ jsonrpc: '2.0', id, error: { code, message } })
  if (method === 'initialize' || (modern && method === 'server/discover')) {
    if (mode === 'exit-init') process.exit(0)
    if (mode === 'wait-init') continue
    result({
      ...(modern
        ? { supportedVersions: ['2026-07-28'] }
        : { protocolVersion: '2025-06-18' }),
      serverInfo: { name: 'modern-bridge-peer', version: String(process.pid) },
      instructions: 'fixture instructions',
      capabilities:
        mode === 'empty'
          ? {}
          : {
              tools: { listChanged: true },
              resources: { subscribe: true, listChanged: true },
              prompts: { listChanged: true },
              completions: {},
              logging: {},
            },
    })
  } else if (method === 'tools/list') {
    if (mode === 'repeat-cursor') result({ tools: [], nextCursor: 'same' })
    else
      result(
        params.cursor
          ? { tools: tools.slice(2) }
          : { tools: tools.slice(0, 2), nextCursor: 'page-2' },
      )
  } else if (method === 'tools/call') {
    const { name, arguments: input } = params
    if (name === 'identity')
      result({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ pid: process.pid, count: ++count }),
          },
        ],
      })
    else if (name === 'echo')
      result({
        content: [{ type: 'text', text: input.value }],
        structuredContent: { value: input.value },
      })
    else if (name === 'crash') process.exit(0)
    else if (name === 'wait') {
      if (params._meta?.progressToken !== undefined)
        send({
          jsonrpc: '2.0',
          method: 'notifications/progress',
          params: {
            progressToken: params._meta.progressToken,
            progress: 1,
            total: 2,
          },
        })
    } else if (name === 'reverse') {
      reverseId = id
      send({ jsonrpc: '2.0', id: 'reverse', method: 'roots/list', params: {} })
    } else error(-32601, 'Unknown fixture tool')
  } else if (id === 'reverse') {
    send({
      jsonrpc: '2.0',
      id: reverseId,
      result: {
        content: [{ type: 'text', text: JSON.stringify(request.error) }],
      },
    })
  } else if (method === 'resources/list')
    result({ resources: [{ uri: 'note://alpha', name: 'Alpha' }] })
  else if (method === 'resources/templates/list')
    result({
      resourceTemplates: [{ uriTemplate: 'note://{name}', name: 'Notes' }],
    })
  else if (method === 'resources/read')
    result({ contents: [{ uri: params.uri, text: 'alpha-body' }] })
  else if (method === 'prompts/list')
    result({
      prompts: [
        { name: 'greet', arguments: [{ name: 'who', required: true }] },
      ],
    })
  else if (method === 'prompts/get')
    result({
      messages: [
        {
          role: 'user',
          content: { type: 'text', text: `hello ${params.arguments.who}` },
        },
      ],
    })
  else if (method === 'completion/complete')
    result({
      completion: { values: ['alice', 'albert'], total: 2, hasMore: false },
    })
  else if (method === 'custom/stream-error') {
    send({
      jsonrpc: '2.0',
      method: 'notifications/progress',
      params: { progressToken: 'p', progress: 1 },
    })
    error(-32601, 'fixture error after progress')
  } else if (method === 'custom/echo') result({ received: params })
  else if (id !== undefined) error(-32601, 'Unknown fixture method')
}
