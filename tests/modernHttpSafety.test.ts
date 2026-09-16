import { test, type TestContext } from 'node:test'
import { knownBugTest } from './helpers/known-bug.js'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { processInfo, reapAfter, stopped } from './helpers/process-tree.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'
import {
  launchGateway,
  unusedPort,
  initialize,
  rpc,
} from './helpers/gateway-process.js'

const VERSION = '2026-07-28'
const meta = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'safety-client', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
async function setup(
  t: TestContext,
  stateful: boolean,
  mode = 'normal',
  env: Record<string, string> = {},
  nodeArgs: string[] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), 'modern-http-'))
  const tracePath = join(directory, 'trace.jsonl')
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      `node tests/helpers/modern-bridge-peer.mjs ${mode}`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      ...(stateful ? ['--stateful'] : []),
    ],
    { ...env, MODERN_TRACE: tracePath, MODERN_WIRE: '1' },
    nodeArgs,
  )
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  await gateway.ready()
  const trace = () => {
    try {
      return readFileSync(tracePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  return { gateway, url: `http://127.0.0.1:${port}/mcp`, trace }
}
async function connect(
  t: TestContext,
  url: string,
  mode: 'auto' | 'legacy' | { pin: string } = { pin: VERSION },
) {
  const client = new Client(
    { name: 'safety-client', version: '1' },
    { versionNegotiation: { mode, probe: { timeoutMs: 5000 } } },
  )
  t.after(() => client.close())
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), {
    timeout: 5000,
  })
  return client
}
async function post(
  url: string,
  method: string,
  params: Record<string, unknown> = {},
  headers: Record<string, string> = {},
  signal = AbortSignal.timeout(5000),
) {
  const res = await fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': VERSION,
      'mcp-method': method,
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 17,
      method,
      params: { _meta: meta, ...params },
    }),
  })
  const text = await res.text()
  const message = text.startsWith('event:')
    ? JSON.parse(
        text
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5),
      )
    : JSON.parse(text)
  return { status: res.status, message, headers: res.headers }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}
async function eventually(
  check: () => boolean,
  description: string | (() => string),
) {
  for (const deadline = Date.now() + 7000; Date.now() < deadline; ) {
    if (check()) return
    await delay(15)
  }
  assert.ok(
    check(),
    typeof description === 'function' ? description() : description,
  )
}

for (const stateful of [true, false]) {
  const label = stateful ? 'stateful' : 'stateless'
  test(
    `${label}: modern discovery, tool schemas and all advertised request surfaces work`,
    { timeout: 30000 },
    async (t) => {
      const { url, trace } = await setup(t, stateful)
      const client = await connect(t, url, 'auto')
      assert.equal(client.getProtocolEra(), 'modern')
      const discovery = client.getDiscoverResult()!
      assert.deepEqual(discovery.supportedVersions, [VERSION])
      assert.equal(discovery.instructions, 'fixture instructions')
      assert.deepEqual(discovery.capabilities, {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
        prompts: { listChanged: true },
        completions: {},
        logging: {},
      })
      const tools = await client.listTools({}, { timeout: 5000 })
      assert.deepEqual(
        tools.tools.map((tool) => tool.name),
        ['identity', 'wait', 'crash', 'reverse', 'echo'],
      )
      const echo = tools.tools.find((tool) => tool.name === 'echo')!
      assert.equal(echo.title, 'Echo value')
      assert.equal(echo.description, 'Echo with schema and metadata')
      assert.deepEqual(echo.annotations, { readOnlyHint: true })
      assert.deepEqual(echo._meta, { custom: 'preserved' })
      assert.equal(
        (echo.inputSchema.properties!.value as any)['x-mcp-header'],
        'Value',
      )
      assert.deepEqual(echo.outputSchema?.required, ['value'])
      const value = 'héllo 世界 🌍'
      const result = await client.callTool(
        { name: 'echo', arguments: { value } },
        { timeout: 5000 },
      )
      assert.deepEqual(result.content, [{ type: 'text', text: value }])
      assert.deepEqual(result.structuredContent, { value })
      assert.deepEqual(
        (await client.listResources({}, { timeout: 5000 })).resources,
        [{ uri: 'note://alpha', name: 'Alpha' }],
      )
      assert.deepEqual(
        (await client.listResourceTemplates({}, { timeout: 5000 }))
          .resourceTemplates,
        [{ uriTemplate: 'note://{name}', name: 'Notes' }],
      )
      assert.deepEqual(
        (await client.readResource({ uri: 'note://alpha' }, { timeout: 5000 }))
          .contents,
        [{ uri: 'note://alpha', text: 'alpha-body' }],
      )
      assert.deepEqual(
        (await client.listPrompts({}, { timeout: 5000 })).prompts,
        [{ name: 'greet', arguments: [{ name: 'who', required: true }] }],
      )
      assert.deepEqual(
        (
          await client.getPrompt(
            { name: 'greet', arguments: { who: 'Ada' } },
            { timeout: 5000 },
          )
        ).messages,
        [{ role: 'user', content: { type: 'text', text: 'hello Ada' } }],
      )
      assert.deepEqual(
        (
          await client.complete(
            {
              ref: { type: 'ref/prompt', name: 'greet' },
              argument: { name: 'who', value: 'al' },
            },
            { timeout: 5000 },
          )
        ).completion,
        { values: ['alice', 'albert'], total: 2, hasMore: false },
      )
      const pids = trace()
        .filter((event) => event.event === 'start')
        .map((event) => event.pid)
      assert.equal(pids.length, 10)
      await eventually(
        () => pids.every((pid) => !alive(pid)),
        'completed modern requests release every child',
      )
    },
  )

  test(
    `${label}: malformed modern metadata and headers cannot dispatch a tool or damage a legacy session`,
    { timeout: 20000 },
    async (t) => {
      const { url, trace } = await setup(t, stateful)
      const legacy = await rpc(url, initialize())
      assert.equal(legacy.response.status, 200)
      const session = legacy.response.headers.get('mcp-session-id') ?? undefined
      const before = trace().filter((event) => event.event === 'start').length
      for (const [params, headers, code] of [
        [
          {
            _meta: {
              ...meta,
              'io.modelcontextprotocol/protocolVersion': '2025-06-18',
            },
          },
          {},
          -32020,
        ],
        [{ _meta: {} }, {}, -32602],
        [{}, { 'mcp-method': 'tools/list' }, -32020],
      ] as const) {
        const rejected = await post(url, 'server/discover', params, headers)
        assert.equal(rejected.status, 400)
        assert.equal(rejected.message.error.code, code)
        assert.equal(rejected.message.id, 17)
      }
      assert.equal(
        trace().filter((event) => event.event === 'start').length,
        before,
        'invalid modern envelopes do not start children',
      )
      const recovered = await rpc(
        url,
        { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
        session,
      )
      assert.equal(recovered.response.status, 200)
      assert.ok(
        recovered.messages[0].result.tools.some(
          (tool: any) => tool.name === 'identity',
        ),
      )
    },
  )

  knownBugTest(
    'PR-193 transparent HTTP parameter validation',
    `${label}: mismatched tool parameter header is rejected before dispatch`,
    { timeout: 15000 },
    async (t) => {
      const { url, trace } = await setup(t, stateful)
      const badTool = await post(
        url,
        'tools/call',
        { name: 'echo', arguments: { value: 'body' } },
        { 'mcp-param-value': 'header' },
      )
      assert.equal(badTool.status, 400)
      assert.equal(badTool.message.error.code, -32020)
      assert.equal(
        trace().some((event) => event.message?.method === 'tools/call'),
        false,
      )
    },
  )

  test(
    `${label}: concurrent modern calls own separate children and preserve request IDs`,
    { timeout: 20000 },
    async (t) => {
      const { url, trace } = await setup(t, stateful)
      const replies = await Promise.all(
        Array.from({ length: 4 }, () =>
          post(url, 'tools/call', { name: 'identity', arguments: {} }),
        ),
      )
      const values = replies.map((reply) => {
        assert.equal(reply.status, 200)
        assert.equal(reply.message.id, 17)
        assert.equal(reply.message.result.resultType, 'complete')
        assert.equal(reply.headers.get('mcp-session-id'), null)
        return JSON.parse(reply.message.result.content[0].text)
      })
      assert.equal(new Set(values.map((value) => value.pid)).size, 4)
      assert.deepEqual(
        values.map((value) => value.count),
        [1, 1, 1, 1],
      )
      await eventually(
        () =>
          trace()
            .filter((event) => event.event === 'start')
            .every((event) => !alive(event.pid)),
        'all isolated children exit after their own replies',
      )
    },
  )

  test(
    `${label}: client abort releases the active child and other requests remain usable`,
    { timeout: 20000 },
    async (t) => {
      const { url, trace } = await setup(t, stateful)
      const controller = new AbortController()
      const pending = post(
        url,
        'tools/call',
        { name: 'wait', arguments: {} },
        {},
        controller.signal,
      )
      // Attach the rejection assertion before aborting to avoid an unhandled-rejection race.
      const aborted = assert.rejects(
        pending,
        (error) => (error as Error).name === 'AbortError',
      )
      await eventually(
        () => trace().some((event) => event.message?.method === 'tools/call'),
        'child receives the blocked call',
      )
      const pid = trace().find(
        (event) => event.message?.method === 'tools/call',
      ).pid
      assert.ok(alive(pid))
      controller.abort()
      await aborted
      await eventually(
        () => !alive(pid),
        'modern disconnection cancels and reaps its child',
      )
      const healthy = await post(url, 'tools/call', {
        name: 'identity',
        arguments: {},
      })
      assert.equal(healthy.status, 200)
      assert.equal(JSON.parse(healthy.message.result.content[0].text).count, 1)
    },
  )

  for (const collect of [false, true])
    test(
      `${label}: progress arrives before cancellation and the blocked child is reaped${collect ? ' after garbage collection' : ''}`,
      { timeout: 20000 },
      async (t) => {
        const { url, trace, gateway } = await setup(
          t,
          stateful,
          'normal',
          {},
          collect
            ? [
                '--expose-gc',
                '--require',
                fileURLToPath(
                  new URL('./helpers/gc-pressure.cjs', import.meta.url),
                ),
              ]
            : [],
        )
        const client = await connect(t, url)
        const controller = new AbortController()
        const progress: unknown[] = []
        const pending = client.callTool(
          { name: 'wait', arguments: {} },
          {
            signal: controller.signal,
            timeout: 10000,
            onprogress: (value) => progress.push(value),
          },
        )
        const cancelled = assert.rejects(pending, /abort|cancel/i)
        await eventually(
          () => progress.length > 0,
          'client receives live progress',
        )
        assert.deepEqual(progress, [{ progress: 1, total: 2 }])
        const pid = trace().find(
          (event) => event.message?.method === 'tools/call',
        ).pid
        assert.ok(alive(pid))
        if (collect) {
          const before = gateway.errors().split('[gc-pressure]').length
          await eventually(
            () => gateway.errors().split('[gc-pressure]').length >= before + 5,
            'collect after the SSE response started',
          )
        }
        controller.abort()
        await cancelled
        await eventually(
          () => !alive(pid),
          () =>
            `cancelled progress stream reaps child ${pid}: ${gateway.errors()} ${JSON.stringify(trace())}`,
        )
      },
    )

  test(
    `${label}: disconnect during discovery reaps the unfinished child`,
    { timeout: 20000 },
    async (t) => {
      const { url, trace } = await setup(t, stateful, 'wait-init')
      const controller = new AbortController()
      const pending = post(url, 'server/discover', {}, {}, controller.signal)
      const cancelled = assert.rejects(pending, { name: 'AbortError' })
      await eventually(
        () =>
          trace().some((event) => event.message?.method === 'server/discover'),
        'child receives discovery',
      )
      const pid = trace().find((event) => event.event === 'start').pid
      assert.ok(alive(pid))
      controller.abort()
      await cancelled
      await eventually(() => !alive(pid), 'aborted discovery reaps child')
    },
  )

  for (const ending of ['disconnect', 'shutdown'] as const) {
    test(
      `${label}: modern ${ending} reaps a TERM-resistant child and descendant`,
      { timeout: 20000, skip: process.platform === 'win32' },
      async (t) => {
        const { url, trace, gateway } = await setup(t, stateful, 'stubborn')
        const controller = new AbortController()
        t.after(() => controller.abort())
        const pending = post(
          url,
          'tools/call',
          { name: 'wait', arguments: {} },
          {},
          controller.signal,
        ).catch((error) => error)
        await eventually(
          () => trace().some((event) => event.message?.method === 'tools/call'),
          'child reaches the pending call',
        )
        const pid = trace().find((event) => event.event === 'start').pid
        const descendant = trace().find(
          (event) => event.event === 'descendant',
        ).descendantPid
        reapAfter(t, pid, processInfo(pid).group)
        reapAfter(t, descendant, processInfo(descendant).group)
        assert.ok(alive(pid))
        assert.ok(alive(descendant))
        if (ending === 'disconnect') controller.abort()
        else gateway.child.kill('SIGTERM')
        await stopped(pid)
        await stopped(descendant)
        if (ending === 'disconnect') {
          assert.equal((await pending).name, 'AbortError')
          assert.equal(gateway.child.exitCode, null)
        } else {
          assert.equal((await gateway.exited).code, 0)
          await pending
        }
      },
    )
  }

  test(
    `${label}: child exit and reverse requests settle without losing the gateway`,
    { timeout: 20000 },
    async (t) => {
      const { url } = await setup(t, stateful)
      const crashed = await post(url, 'tools/call', {
        name: 'crash',
        arguments: {},
      })
      assert.equal(crashed.status, 200)
      assert.ok(
        crashed.message.error || crashed.message.result?.isError,
        JSON.stringify(crashed.message),
      )
      const reverse = await post(url, 'tools/call', {
        name: 'reverse',
        arguments: {},
      })
      assert.equal(reverse.status, 200)
      assert.deepEqual(reverse.message.error, {
        code: -32603,
        message: 'MCP server process failed',
      })
      const healthy = await post(url, 'tools/call', {
        name: 'identity',
        arguments: {},
      })
      assert.equal(healthy.status, 200)
    },
  )

  test(
    `${label}: custom requests preserve extension results and unknown-method errors`,
    { timeout: 15000 },
    async (t) => {
      const { url } = await setup(t, stateful)
      const custom = await post(url, 'custom/echo', {
        value: 7,
        nested: { kept: true },
      })
      assert.equal(custom.status, 200)
      assert.equal(custom.message.id, 17)
      assert.deepEqual(custom.message.result.received, {
        _meta: meta,
        value: 7,
        nested: { kept: true },
      })
      const unknown = await post(url, 'custom/unknown')
      assert.equal(unknown.status, 200)
      assert.equal(unknown.message.id, 17)
      assert.deepEqual(unknown.message.error, {
        code: -32601,
        message: 'Unknown fixture method',
      })
    },
  )

  test(
    `${label}: tool schemas pass through without fetching or compiling remote references`,
    { timeout: 15000 },
    async (t) => {
      let requests = 0
      const endpoint = createServer((_req, res) => {
        requests++
        res.end('{"type":"object"}')
      })
      await new Promise<void>((resolve) =>
        endpoint.listen(0, '127.0.0.1', resolve),
      )
      t.after(
        () =>
          new Promise<void>((resolve, reject) =>
            endpoint.close((error) => (error ? reject(error) : resolve())),
          ),
      )
      const address = endpoint.address()
      assert.ok(address && typeof address !== 'string')
      const reference = `http://127.0.0.1:${address.port}/schema.json`
      // Positive control: the endpoint is reachable before the schema probe.
      assert.equal((await fetch(reference)).status, 200)
      assert.equal(requests, 1)
      requests = 0
      const { url, trace } = await setup(t, stateful, 'normal', {
        MODERN_SCHEMA_REF: reference,
      })
      const response = await post(url, 'tools/list', { cursor: 'page-2' })
      assert.equal(response.status, 200)
      const echo = response.message.result.tools.find(
        (tool: any) => tool.name === 'echo',
      )
      assert.equal(echo.inputSchema.$ref, reference)
      assert.equal(
        trace().filter((event) => event.message?.method === 'tools/list')
          .length,
        1,
      )
      await eventually(
        () =>
          trace()
            .filter((event) => event.event === 'start')
            .every((event) => !alive(event.pid)),
        'completed schema response releases the child',
      )
      assert.equal(
        requests,
        0,
        'the relay preserves schema references without fetching them',
      )
    },
  )

  for (const mode of ['exit-init']) {
    test(
      `${label}: ${mode} fails promptly and releases its child`,
      { timeout: 15000 },
      async (t) => {
        const { url, trace } = await setup(t, stateful, mode)
        const reply = await post(url, 'server/discover')
        assert.equal(reply.status, 200)
        assert.equal(reply.message.error.code, -32603)
        assert.equal(reply.message.id, 17)
        await eventually(
          () =>
            trace()
              .filter((event) => event.event === 'start')
              .every((event) => !alive(event.pid)),
          'failed setup is reaped',
        )
      },
    )
  }
}
