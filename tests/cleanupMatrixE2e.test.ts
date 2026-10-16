import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  nodeServer,
  requestTimeout,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'
import { isAlive } from './helpers/process-tree.js'

// Every way a client's server can end, on every output: afterwards no server
// the gateway started is running. The server ignores its stdin closing (see
// stubborn-peer.mjs), so it is gone only if the gateway ended it, and it runs
// either as the command itself or under a wrapper, as npx runs one. On
// Windows both run under cmd.exe, as `--stdio` runs every command there.

type Output = 'sse' | 'ws' | 'stateful' | 'stateless' | 'modern'
type Ending =
  | 'client leaves'
  | 'DELETE'
  | 'session timeout'
  | 'request done'
  | 'server crash'
  | 'wrapper crash'
  | 'SIGINT'
  | 'SIGTERM'
  | 'stdin closes'

const peer = resolve('tests/helpers/stubborn-peer.mjs')
const wrapper = resolve('tests/helpers/stubborn-wrapper.mjs')
const options = { timeout: gatewayTimeout(30000) }
const shutdowns = ['SIGINT', 'SIGTERM', 'stdin closes'] as const
const endings: Record<Output, Ending[]> = {
  sse: ['client leaves', 'server crash', 'wrapper crash', ...shutdowns],
  ws: ['client leaves', 'server crash', 'wrapper crash', ...shutdowns],
  stateful: [
    'DELETE',
    'session timeout',
    'server crash',
    'wrapper crash',
    ...shutdowns,
  ],
  stateless: ['request done', ...shutdowns],
  modern: ['request done', ...shutdowns],
}

const VERSION = '2026-07-28'
const modernMeta = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'cleanup', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
const call = (name: string, id = 2) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: {} },
})

// The PIDs the servers and wrappers left in `dir`.
const started = (dir: string) =>
  readdirSync(dir).map((name) => Number(name.split('-')[1]))

const pidDirectory = (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), 'sg-cleanup-'))
  t.after(() => {
    // Safety net, after the assertions: nothing outlives the test.
    for (const pid of started(dir))
      if (isAlive(pid))
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // Gone in between.
        }
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

const until = async (check: () => boolean, what: () => string) => {
  const deadline = Date.now() + requestTimeout(10000)
  while (!check()) {
    if (Date.now() > deadline) assert.fail(what())
    await delay(25)
  }
}

// Every process that started has ended.
const allGone = (dir: string, expected: number) =>
  until(
    () =>
      started(dir).length >= expected &&
      started(dir).every((pid) => !isAlive(pid)),
    () => {
      const pids = started(dir)
      return pids.length < expected
        ? `only ${pids.length} of ${expected} processes started`
        : `still running: ${pids.filter(isAlive).join(', ')}`
    },
  )

// An SSE client: the stream it holds open, and where it posts.
async function sseClient(t: TestContext, port: number) {
  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await fetch(`http://127.0.0.1:${port}/sse`, {
    signal: abort.signal,
  })
  const reader = response.body!.getReader()
  let text = ''
  while (!/event: endpoint\ndata: (.+)\n/.test(text)) {
    const { value, done } = await reader.read()
    assert.equal(done, false, 'the SSE stream ended before its endpoint')
    text += Buffer.from(value!).toString()
  }
  const endpoint = new URL(
    text.match(/event: endpoint\ndata: (.+)\n/)![1].trim(),
    `http://127.0.0.1:${port}`,
  )
  // Replies arrive on the stream; reading keeps it flowing.
  void (async () => {
    for (;;)
      if ((await reader.read().catch(() => ({ done: true }))).done) return
  })()
  const post = (message: object) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    })
  return { post, leave: () => abort.abort() }
}

async function wsClient(t: TestContext, port: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
  t.after(() => socket.terminate())
  await once(socket, 'open')
  return {
    send: (message: object) => socket.send(JSON.stringify(message)),
    reply: async () => JSON.parse(String((await once(socket, 'message'))[0])),
    leave: () => socket.close(),
  }
}

const modernPost = (
  url: string,
  method: string,
  params: object,
  signal?: AbortSignal,
) =>
  fetch(url, {
    method: 'POST',
    signal,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': VERSION,
      'mcp-method': method,
      ...('name' in params ? { 'mcp-name': String(params.name) } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method,
      params: { _meta: modernMeta, ...params },
    }),
  })

for (const output of Object.keys(endings) as Output[]) {
  for (const wrapped of [false, true]) {
    for (const ending of endings[output].filter(
      (ending) => wrapped || ending !== 'wrapper crash',
    )) {
      test(
        `${output}, ${wrapped ? 'wrapped server' : 'server'}: ${ending} leaves no server running`,
        options,
        async (t) => {
          const dir = pidDirectory(t)
          // A server and its wrapper, when there is one.
          const per = wrapped ? 2 : 1
          const port = await unusedPort()
          const gateway = launchGateway(
            t,
            [
              '--stdio',
              nodeServer(JSON.stringify(wrapped ? wrapper : peer)),
              '--port',
              String(port),
              '--outputTransport',
              output === 'sse' || output === 'ws' ? output : 'streamableHttp',
              ...(output === 'stateful' ? ['--stateful'] : []),
              ...(ending === 'session timeout'
                ? ['--sessionTimeout', '500']
                : []),
            ],
            { CLEANUP_PIDS: dir },
          )
          await gateway.ready()
          const url = `http://127.0.0.1:${port}/mcp`
          let leave = () => {}
          let crash = async (_tool: string) => {}
          if (output === 'sse') {
            const client = await sseClient(t, port)
            assert.equal((await client.post(initialize())).status, 202)
            leave = client.leave
            crash = async (tool) => void (await client.post(call(tool)))
          } else if (output === 'ws') {
            const client = await wsClient(t, port)
            client.send(initialize())
            await client.reply()
            leave = client.leave
            crash = async (tool) => client.send(call(tool))
          } else if (output === 'stateful') {
            const first = await rpc(url, initialize())
            const session = first.response.headers.get('mcp-session-id')!
            assert.ok(session)
            leave = () =>
              void fetch(url, {
                method: 'DELETE',
                headers: { 'mcp-session-id': session },
              })
            crash = async (tool) =>
              void (await rpc(url, call(tool), session).catch(() => {}))
          } else if (ending !== 'request done') {
            // A call that is still running when the gateway stops.
            const abort = new AbortController()
            t.after(() => abort.abort())
            void (
              output === 'modern'
                ? modernPost(
                    url,
                    'tools/call',
                    { name: 'hang', arguments: {} },
                    abort.signal,
                  )
                : fetch(url, {
                    method: 'POST',
                    signal: abort.signal,
                    headers: {
                      'content-type': 'application/json',
                      accept: 'application/json, text/event-stream',
                    },
                    body: JSON.stringify(call('hang')),
                  })
            ).catch(() => {})
          } else if (output === 'modern') {
            const reply = await modernPost(url, 'tools/call', {
              name: 'ping',
              arguments: {},
            })
            assert.equal(reply.status, 200, await reply.text())
          } else {
            assert.equal((await rpc(url, initialize())).response.status, 200)
          }
          await until(
            () => started(dir).length >= per,
            () => `the server did not start: ${gateway.errors()}`,
          )
          const expected = started(dir).length
          if (ending === 'client leaves' || ending === 'DELETE') leave()
          else if (ending === 'server crash') await crash('crash')
          else if (ending === 'wrapper crash') await crash('orphan')
          else if (ending === 'stdin closes') gateway.child.stdin.end()
          else if (ending === 'SIGINT' || ending === 'SIGTERM')
            gateway.interrupt(ending)
          await allGone(dir, expected)
          if ((shutdowns as readonly string[]).includes(ending)) {
            const exit = await gateway.exited
            assert.equal(exit.code, 0, gateway.errors())
          } else {
            assert.equal(gateway.child.exitCode, null, 'the gateway stays up')
            // And serves the next client.
            if (output !== 'sse' && output !== 'ws') {
              const next =
                output === 'modern'
                  ? await modernPost(url, 'tools/call', {
                      name: 'ping',
                      arguments: {},
                    })
                  : (await rpc(url, initialize(5))).response
              assert.equal(next.status, 200)
            }
          }
        },
      )
    }
  }
}

// A config file runs `command` + `args` without a shell, and a combined entry
// runs several servers for one session: each is ended with its session, and
// all of them when the gateway stops.
for (const shape of ['config entry', 'combined entry'] as const) {
  for (const ending of ['DELETE', 'server crash', ...shutdowns] as const) {
    test(`${shape}: ${ending} leaves no server running`, options, async (t) => {
      const dir = pidDirectory(t)
      const port = await unusedPort()
      const server = { command: process.execPath, args: [wrapper] }
      const file = join(dir, '..', `${port}-servers.json`)
      writeFileSync(
        file,
        JSON.stringify({
          port,
          outputTransport: 'streamableHttp',
          stateful: true,
          mcpServers: {
            entry:
              shape === 'combined entry'
                ? {
                    mcpServers: {
                      one: server,
                      two: { ...server, toolPrefix: 'two_' },
                    },
                  }
                : server,
          },
        }),
      )
      t.after(() => rmSync(file, { force: true }))
      const gateway = launchGateway(t, ['--config', file], {
        CLEANUP_PIDS: dir,
      })
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/entry/mcp`
      const first = await rpc(url, initialize())
      assert.equal(first.response.status, 200)
      const session = first.response.headers.get('mcp-session-id')!
      const per = shape === 'combined entry' ? 4 : 2
      await until(
        () => started(dir).length >= per,
        () => `the servers did not start: ${gateway.errors()}`,
      )
      if (ending === 'DELETE')
        await fetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': session },
        })
      else if (ending === 'server crash')
        await rpc(url, call('crash'), session).catch(() => {})
      else if (ending === 'stdin closes') gateway.child.stdin.end()
      else gateway.interrupt(ending)
      if (shape === 'combined entry' && ending === 'server crash') {
        // One server of the session crashed; the other serves on until the
        // session ends.
        await until(
          () => started(dir).filter(isAlive).length === 2,
          () => `still running: ${started(dir).filter(isAlive).join(', ')}`,
        )
        await fetch(url, {
          method: 'DELETE',
          headers: { 'mcp-session-id': session },
        })
      }
      await allGone(dir, per)
      if ((shutdowns as readonly string[]).includes(ending))
        assert.equal((await gateway.exited).code, 0, gateway.errors())
      else assert.equal(gateway.child.exitCode, null, 'the gateway stays up')
    })
  }
}
