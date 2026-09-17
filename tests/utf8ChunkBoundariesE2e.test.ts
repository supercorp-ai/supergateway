import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { WebSocket } from 'ws'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  initialize,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

const expected = { content: [{ type: 'text', text: 'ą€🙂漢' }] }
const call = {
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: 'unicode', arguments: {} },
}

test(
  'UTF-8 fixture emits an intact JSON value when decoded as a byte stream',
  { timeout: 10000 },
  async (t) => {
    const peer = spawn(
      process.execPath,
      ['tests/helpers/utf8-boundary-peer.mjs'],
      { env: { ...process.env, SPLIT_UTF8: '1' } },
    )
    t.after(() => peer.kill())
    const lines = createInterface({ input: peer.stdout })
    const reply = once(lines, 'line')
    peer.stdin.write(JSON.stringify(call) + '\n')
    assert.deepEqual(JSON.parse((await reply)[0]).result, expected)
    lines.close()
  },
)

for (const mode of ['sse', 'stateful', 'stateless', 'ws'] as const) {
  for (const split of [false, true]) {
    // GW-031: streaming decoding must preserve scalars across pipe chunks.
    // Direct streaming and whole writes remain paired controls.
    test(
      `${mode} preserves Unicode with ${split ? 'split' : 'whole'} UTF-8 characters on child stdout`,
      { timeout: 15000 },
      async (t) => {
        const port = await unusedPort()
        const gateway = launchGateway(
          t,
          [
            '--stdio',
            'node tests/helpers/utf8-boundary-peer.mjs',
            '--port',
            String(port),
            '--outputTransport',
            mode === 'stateful' || mode === 'stateless'
              ? 'streamableHttp'
              : mode,
            ...(mode === 'stateful' ? ['--stateful'] : []),
          ],
          { SPLIT_UTF8: split ? '1' : '0' },
        )
        await gateway.ready()
        if (mode === 'ws') {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
          t.after(() => socket.terminate())
          await once(socket, 'open')
          const initialized = once(socket, 'message')
          socket.send(JSON.stringify(initialize()))
          await initialized
          const received = once(socket, 'message')
          socket.send(JSON.stringify(call))
          const reply = JSON.parse(String((await received)[0]))
          assert.equal(reply.id, call.id)
          assert.deepEqual(reply.result, expected)
        } else {
          const client = new Client(
            { name: 'unicode-audit', version: '1.0.0' },
            { capabilities: {} },
          )
          const url = new URL(
            `http://127.0.0.1:${port}/${mode === 'sse' ? 'sse' : 'mcp'}`,
          )
          const transport =
            mode === 'sse'
              ? new SSEClientTransport(url)
              : new StreamableHTTPClientTransport(url)
          t.after(() => client.close())
          t.after(() => transport.close())
          await client.connect(transport)
          assert.deepEqual(
            await client.callTool({ name: 'unicode', arguments: {} }),
            expected,
          )
        }
      },
    )
  }
}
