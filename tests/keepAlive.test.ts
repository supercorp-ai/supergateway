import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

// Node closes an idle HTTP connection after 5 seconds. A client or proxy that
// reuses one just as the server closes it gets a reset, and load balancers hold
// idle connections for 60 seconds by default (AWS ALB). Every HTTP-serving
// mode now keeps them for 65, so the other side always closes first.
const MODES = [
  ['SSE', ['--outputTransport', 'sse']],
  ['stateful HTTP', ['--outputTransport', 'streamableHttp', '--stateful']],
  ['stateless HTTP', ['--outputTransport', 'streamableHttp']],
  ['WebSocket', ['--outputTransport', 'ws']],
] as const

test(
  'every mode keeps an idle connection open past Node’s 5-second default',
  { timeout: 30000 },
  async (t) => {
    await Promise.all(
      MODES.map(async ([label, args]) => {
        const port = await unusedPort()
        const gateway = launchGateway(t, [
          '--stdio',
          peerCommand,
          '--port',
          String(port),
          '--healthEndpoint',
          '/health',
          ...args,
        ])
        await gateway.ready()
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
        t.after(() => agent.destroy())
        const get = () =>
          new Promise<{ reused: boolean; body: string }>((resolve, reject) => {
            const req = http.get(
              { host: '127.0.0.1', port, path: '/health', agent },
              (res) => {
                let body = ''
                res.setEncoding('utf8').on('data', (c: string) => (body += c))
                res.on('end', () => resolve({ reused: req.reusedSocket, body }))
              },
            )
            req.on('error', reject)
          })
        assert.deepEqual(await get(), { reused: false, body: 'ok' }, label)
        await delay(6000)
        assert.deepEqual(
          await get(),
          { reused: true, body: 'ok' },
          `${label}: the idle connection was closed within 6 seconds`,
        )
      }),
    )
  },
)
