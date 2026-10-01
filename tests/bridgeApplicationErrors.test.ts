import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

// GW-036. An upstream server's application error (a JSON-RPC code outside the
// reserved range) reaches a bridge's stdio client as the server sent it.
// 3.4.3 kept the code; from 4.0.0 the bridges answered
//   {"code":-32000,"message":"HTTP 42: MCP error 42: quota exceeded"}
// for the server's {"code":42,"message":"quota exceeded"}.
const bridges = {
  '--sse': { upstream: [], path: '/sse' },
  '--streamableHttp': {
    upstream: ['--outputTransport', 'streamableHttp', '--stateful'],
    path: '/mcp',
  },
}

for (const [flag, { upstream, path }] of Object.entries(bridges)) {
  test(
    `${flag} bridge passes an application error through as the server sent it`,
    { timeout: gatewayTimeout(30000) },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        'node tests/helpers/app-error-peer.mjs',
        ...upstream,
        '--port',
        String(port),
      ])
      await gateway.ready()
      const bridge = spawn(
        process.execPath,
        [
          process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js',
          flag,
          `http://127.0.0.1:${port}${path}`,
          '--logLevel',
          'none',
        ],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      )
      t.after(() => bridge.kill('SIGKILL'))
      const replies = new Map<unknown, any>()
      let buffer = ''
      bridge.stdout.setEncoding('utf8').on('data', (chunk: string) => {
        buffer += chunk
        let end: number
        while ((end = buffer.indexOf('\n')) >= 0) {
          const message = JSON.parse(buffer.slice(0, end))
          buffer = buffer.slice(end + 1)
          if ('id' in message) replies.set(message.id, message)
        }
      })
      const send = (message: object) =>
        bridge.stdin.write(JSON.stringify(message) + '\n')
      const wait = async (id: number) => {
        const deadline = Date.now() + 15000
        while (!replies.has(id)) {
          assert.ok(Date.now() < deadline, `no reply to ${id}`)
          await delay(20)
        }
        return replies.get(id)
      }
      send(initialize(1))
      await wait(1)
      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'x', arguments: {} },
      })
      assert.deepEqual((await wait(2)).error, {
        code: 42,
        message: 'quota exceeded',
        data: { retryAfter: 5 },
      })
    },
  )
}
