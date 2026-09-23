import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  initialize,
  launchGateway,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

test(
  'an idle SDK client answers a server ping and retains its original stateful peer',
  { timeout: 45000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/session-state-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '300',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    )
    const client = new Client({ name: 'liveness-test', version: '1.0.0' })
    t.after(() => client.close())
    await client.connect(transport)
    const step = async () => {
      const reply = await client.callTool({ name: 'step', arguments: {} })
      assert.notEqual(reply.isError, true)
      return JSON.parse((reply.content[0] as { text: string }).text) as {
        pid: number
        calls: number
      }
    }
    const first = await step()
    await gateway.waitFor(
      () => gateway.output().includes('GET request for existing session'),
      'open the SDK client’s standalone GET stream',
    )
    const deadline = Date.now() + 35_000
    while (!gateway.output().includes('Sending session liveness ping')) {
      assert.ok(Date.now() < deadline, gateway.output())
      await delay(100)
    }
    // A ping response is an HTTP POST, and it must keep the same session alive.
    await delay(500)
    assert.deepEqual(await step(), { pid: first.pid, calls: 2 })
  },
)

test(
  'the default session timeout probes an SDK client shortly after its GET opens',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/session-state-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`),
    )
    const client = new Client({
      name: 'default-liveness-test',
      version: '1.0.0',
    })
    t.after(() => client.close())
    await client.connect(transport)
    const first = await client.callTool({ name: 'step', arguments: {} })
    const firstState = JSON.parse(
      (first.content[0] as { text: string }).text,
    ) as {
      pid: number
      calls: number
    }
    await gateway.waitFor(
      () => gateway.output().includes('GET request for existing session'),
      'open the SDK client’s standalone GET stream',
    )
    const postsBeforePing = gateway
      .output()
      .split('POST request for existing session').length
    const deadline = Date.now() + 15_000
    while (!gateway.output().includes('Sending session liveness ping')) {
      assert.ok(Date.now() < deadline, gateway.output())
      await delay(100)
    }
    await gateway.waitFor(
      () =>
        gateway.output().split('POST request for existing session').length >
        postsBeforePing,
      'receive the SDK client’s ping reply',
    )
    const second = await client.callTool({ name: 'step', arguments: {} })
    assert.deepEqual(JSON.parse((second.content[0] as { text: string }).text), {
      pid: firstState.pid,
      calls: 2,
    })
  },
)

test(
  'an idle client that never answers server pings retains its existing session',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/session-state-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '5000',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`
    const initialized = await rpc(url, initialize())
    const session = initialized.response.headers.get('mcp-session-id')!
    assert.ok(session)
    const abort = new AbortController()
    t.after(() => abort.abort())
    const stream = await fetch(url, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': session },
      signal: abort.signal,
    })
    assert.equal(stream.status, 200)
    void stream.text().catch(() => {})
    const deadline = Date.now() + 20_000
    while (
      !gateway
        .output()
        .includes('Client has not answered liveness pings; preserving session')
    ) {
      assert.ok(Date.now() < deadline, gateway.output())
      await delay(100)
    }
    const reply = await rpc(
      url,
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'step', arguments: {} },
      },
      session,
    )
    assert.equal(reply.response.status, 200)
    assert.equal(reply.messages[0].id, 10)
  },
)
