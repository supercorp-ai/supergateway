import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { get } from 'node:http'
import { createInterface } from 'node:readline'
import { execFileSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocket } from 'ws'
import {
  initialize,
  rpc,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'
import { faultControl } from './helpers/fault-control.js'

type Mode = 'sse' | 'ws' | 'stateful' | 'stateless'
async function connect(t: TestContext, mode: Mode, port: number) {
  if (mode === 'ws') {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/message`)
    t.after(() => ws.terminate())
    await once(ws, 'open')
    let id = 1
    const request = async (body: object) => {
      const reply = once(ws, 'message', { signal: AbortSignal.timeout(8000) })
      ws.send(JSON.stringify({ ...body, id: id++ }))
      return JSON.parse(String((await reply)[0])).result
    }
    await request(initialize())
    return {
      call: (name: string) =>
        request({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name, arguments: {} },
        }),
    }
  }
  const client = new Client(
    { name: 'stdout-limit', version: '1' },
    { capabilities: {} },
  )
  const url = new URL(
    `http://127.0.0.1:${port}/${mode === 'sse' ? 'sse' : 'mcp'}`,
  )
  const transport =
    mode === 'sse'
      ? new SSEClientTransport(url)
      : new StreamableHTTPClientTransport(url)
  t.after(() => client.close().catch(() => {}))
  await client.connect(transport, { timeout: 8000 })
  return {
    call: (name: string) =>
      client.callTool({ name, arguments: {} }, undefined, { timeout: 8000 }),
  }
}
async function largeResult(
  t: TestContext,
  mode: Mode,
  port: number,
  gateway: ReturnType<typeof launchGateway>,
) {
  if (mode === 'ws') return (await connect(t, mode, port)).call('large')
  const body = {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'large', arguments: {} },
  }
  if (mode !== 'sse') {
    const url = `http://127.0.0.1:${port}/mcp`
    const first = await rpc(url, initialize())
    const session = first.response.headers.get('mcp-session-id') ?? undefined
    const reply = await rpc(url, body, session)
    assert.equal(reply.response.status, 200)
    assert.equal(reply.messages.length, 1)
    return reply.messages[0].result
  }
  const request = get(`http://127.0.0.1:${port}/sse`)
  t.after(() => request.destroy())
  const [response] = await once(request, 'response')
  const lines = createInterface({ input: response })
  t.after(() => lines.close())
  let streamError: Error | undefined
  lines.on('error', (error) => {
    streamError = error
  })
  const observed = (predicate: () => boolean) => {
    if (streamError) throw streamError
    return predicate()
  }
  let endpoint = ''
  const replies: any[] = []
  lines.on('line', (line) => {
    if (!line.startsWith('data:')) return
    const data = line.slice(5).trim()
    if (data.startsWith('/')) endpoint = data
    else replies.push(JSON.parse(data))
  })
  await gateway.waitFor(
    () => observed(() => Boolean(endpoint)),
    'receive SSE endpoint',
  )
  for (const message of [initialize(), body]) {
    const result = await fetch(new URL(endpoint, `http://127.0.0.1:${port}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000),
    })
    await result.text()
    assert.equal(result.status, 202)
    await gateway.waitFor(
      () => observed(() => replies.some((reply) => reply.id === message.id)),
      'receive complete large response',
    )
  }
  return replies.find((reply) => reply.id === 2).result
}

async function stopped(pid: number) {
  const alive = () => {
    try {
      return !execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
        encoding: 'utf8',
      })
        .trim()
        .startsWith('Z')
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false
      throw error
    }
  }
  const deadline = Date.now() + 7000
  while (alive() && Date.now() < deadline) await delay(20)
  assert.equal(
    alive(),
    false,
    `offending peer ${pid} must terminate before harness cleanup`,
  )
}
for (const mode of ['sse', 'ws', 'stateful', 'stateless'] as const) {
  for (const limited of [true, false]) {
    test(
      `${mode}: ${limited ? 'opt-in stdout limit stops a newline-free flood' : 'default unlimited stdout accepts a valid message above 16 MiB'}`,
      { timeout: 30000 },
      async (t) => {
        const control = await faultControl(t)
        const port = await unusedPort()
        const gateway = launchGateway(
          t,
          [
            '--stdio',
            'exec node tests/helpers/stdout-limit-peer.mjs',
            '--port',
            String(port),
            '--outputTransport',
            mode === 'stateful' || mode === 'stateless'
              ? 'streamableHttp'
              : mode,
            ...(mode === 'stateful' ? ['--stateful'] : []),
            ...(limited
              ? ['--maxStdoutLineBytes', '4096']
              : ['--logLevel', 'none']),
            '--healthEndpoint',
            '/health',
          ],
          {
            NODE_OPTIONS: '--max-old-space-size=192',
            FAULT_CONTROL: control.url,
          },
        )
        if (limited) await gateway.ready()
        else {
          // With logging disabled, observe the actual HTTP listener.
          const deadline = Date.now() + 8000
          while (true) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/health`)
              assert.equal(await response.text(), 'ok')
              break
            } catch (error) {
              if (Date.now() > deadline || gateway.child.exitCode !== null)
                throw error
              await delay(20)
            }
          }
        }
        if (!limited) {
          const result = await largeResult(t, mode, port, gateway).catch(
            (error: Error) => {
              throw new Error(
                `Large response failed; exit=${gateway.child.exitCode} signal=${gateway.child.signalCode}: ${gateway.errors()}`,
                { cause: error },
              )
            },
          )
          assert.deepEqual(result, {
            content: [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024 + 1) }],
          })
          assert.equal(gateway.child.exitCode, null)
          return
        }
        const client = await connect(t, mode, port)
        const healthy =
          mode === 'stateful' || mode === 'stateless'
            ? await connect(t, mode, port)
            : undefined
        const before = healthy ? await healthy.call('identity') : undefined
        const pending = client.call('flood').then(
          (value) => ({ value }),
          (error) => ({ error }),
        )
        const event = await control.wait('flood-start')
        if (healthy) {
          const outcome = await pending
          assert.ok(
            'error' in outcome,
            'flooded request must fail, not succeed',
          )
          assert.equal(
            outcome.error.code,
            -32603,
            'settle as protocol failure, not timeout',
          )
          const after = await healthy.call('identity')
          if (mode === 'stateful')
            assert.deepEqual(
              after,
              before,
              'other session keeps its original peer',
            )
          else
            assert.ok(
              Number(after.content[0].text) > 0,
              'fresh stateless request still succeeds',
            )
          assert.equal(gateway.child.exitCode, null)
          assert.equal(gateway.child.signalCode, null)
        } else {
          assert.deepEqual(
            await gateway.exited,
            { code: 1, signal: null },
            'shared-child modes fail cleanly, never SIGABRT or success',
          )
        }
        assert.match(
          gateway.errors(),
          /Child stdout line exceeds maxStdoutLineBytes \(4096 bytes\)/,
        )
        await stopped(event.pid)
      },
    )
  }
}
