import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { IncomingMessage } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { WebSocket } from 'ws'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * `--cors` on a WebSocket gateway, end to end.
 *
 * Browsers apply no CORS to a WebSocket handshake, so with origins listed the
 * gateway checks `Origin` itself. A browser's handshake carries it; here the
 * client sets it.
 *
 * Without `--cors`, nothing changes: a client with any Origin still connects,
 * as every existing one does, and the operator is told which origins did.
 */

const options = { timeout: gatewayTimeout(30000) }

// The first answer to an upgrade: the connection, initialized, or a refusal.
const connect = (port: number, origin?: string, path = '/message') =>
  new Promise<{ status: number; body: string; reply?: any }>(
    (resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${port}${path}`,
        origin === undefined ? {} : { origin },
      )
      const timer = setTimeout(
        () => reject(Error('no answer')),
        requestTimeout(10000),
      )
      ws.once('open', () => ws.send(JSON.stringify(initialize(1))))
      ws.once('message', (data) => {
        clearTimeout(timer)
        ws.close()
        resolve({ status: 101, body: '', reply: JSON.parse(String(data)) })
      })
      ws.once('unexpected-response', (_req, res: IncomingMessage) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk) => (body += chunk))
        res.on('end', () => {
          clearTimeout(timer)
          resolve({ status: res.statusCode!, body })
        })
      })
      ws.once('error', reject)
    },
  )

const gatewayWith = async (t: TestContext, args: string[]) => {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--outputTransport',
    'ws',
    '--port',
    String(port),
    ...args,
  ])
  await gateway.ready()
  return { port, gateway }
}

const served = (answer: { status: number; reply?: any }) => {
  assert.equal(answer.status, 101)
  assert.ok(answer.reply.result.serverInfo, 'initialize was answered')
}

test(
  '--cors with origins: a page on another origin cannot open the WebSocket',
  options,
  async (t) => {
    const { port, gateway } = await gatewayWith(t, [
      '--cors',
      'http://allowed.test',
      '--cors',
      '/^https:\\/\\/[a-z]+\\.allowed\\.test$/',
    ])
    const refused = await connect(port, 'http://evil.test')
    assert.equal(refused.status, 403)
    assert.match(refused.body, /Forbidden: origin not allowed/)
    served(await connect(port, 'http://allowed.test'))
    served(await connect(port, 'https://blue.allowed.test'))
    // A client that is not a browser sends no Origin, and connects as ever.
    served(await connect(port))
    await gateway.waitFor(
      () =>
        gateway
          .output()
          .includes(
            'Refused a WebSocket connection from http://evil.test: not in --cors',
          ),
      'the refusal to be logged',
    )
    assert.doesNotMatch(gateway.output(), /New WebSocket connection.*evil/)
  },
)

test(
  'without --cors, a page on any origin connects as before, and is logged',
  options,
  async (t) => {
    const { port, gateway } = await gatewayWith(t, [])
    served(await connect(port, 'http://page.test'))
    served(await connect(port, 'http://page.test'))
    served(await connect(port))
    await gateway.waitFor(
      () =>
        gateway
          .output()
          .includes(
            'A web page at http://page.test connected over WebSocket. --cors limits which origins can.',
          ),
      'the origin to be logged',
    )
    assert.equal(gateway.output().split('A web page at').length, 2)
  },
)

test('bare --cors: every origin connects', options, async (t) => {
  const { port, gateway } = await gatewayWith(t, ['--cors'])
  served(await connect(port, 'http://page.test'))
  assert.doesNotMatch(gateway.output(), /A web page at|Refused a WebSocket/)
})

test(
  'a config file entry: its "cors" applies to its WebSocket, another entry is unaffected',
  options,
  async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'sg-ws-origin-'))
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10 }))
    const file = join(dir, 'servers.json')
    const port = await unusedPort()
    const mock = {
      command: process.execPath,
      args: [resolve('tests/helpers/mock-mcp-server.js'), 'stdio'],
    }
    writeFileSync(
      file,
      JSON.stringify({
        port,
        mcpServers: {
          strict: {
            ...mock,
            outputTransport: 'ws',
            cors: ['http://allowed.test'],
          },
          open: { ...mock, outputTransport: 'ws' },
        },
      }),
    )
    const gateway = launchGateway(t, ['--config', file])
    await gateway.ready()
    assert.equal(
      (await connect(port, 'http://evil.test', '/strict/message')).status,
      403,
    )
    served(await connect(port, 'http://allowed.test', '/strict/message'))
    served(await connect(port, 'http://evil.test', '/open/message'))
  },
)
