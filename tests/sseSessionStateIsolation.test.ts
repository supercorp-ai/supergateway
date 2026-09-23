import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

test(
  'concurrent SSE clients own separate child state and survive a peer exit',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/session-state-peer.mjs',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const connect = async (name: string) => {
      const client = new Client(
        { name, version: '1.0.0' },
        { capabilities: {} },
      )
      const transport = new SSEClientTransport(
        new URL(`http://127.0.0.1:${port}/sse`),
      )
      t.after(() => transport.close().catch(() => {}))
      t.after(() => client.close().catch(() => {}))
      await client.connect(transport)
      return { client, transport }
    }
    const identity = async (client: Client) => {
      const reply = await client.callTool({ name: 'step', arguments: {} })
      assert.equal(reply.isError, undefined)
      return JSON.parse((reply.content[0] as { text: string }).text) as {
        pid: number
        calls: number
      }
    }

    const first = await connect('first')
    const second = await connect('second')
    const a1 = await identity(first.client)
    const b1 = await identity(second.client)
    assert.notEqual(a1.pid, b1.pid, 'sessions cannot share a stateful child')
    assert.equal(a1.calls, 1)
    assert.equal(b1.calls, 1)
    assert.deepEqual(await identity(first.client), { pid: a1.pid, calls: 2 })
    assert.deepEqual(await identity(second.client), { pid: b1.pid, calls: 2 })

    await first.client.close()
    await gateway.waitFor(
      () => gateway.output().includes('Child exited (session '),
      'stop the closed session’s child',
    )
    assert.deepEqual(await identity(second.client), { pid: b1.pid, calls: 3 })
    assert.equal(gateway.child.exitCode, null)
  },
)
