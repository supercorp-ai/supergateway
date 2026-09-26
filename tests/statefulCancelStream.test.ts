import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { observeGateway } from './helpers/observed-gateway.js'
import {
  initialize,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

// A server sends nothing for a cancelled call, and in stateful HTTP the
// response stream for that call stayed open until the session ended: every
// cancel held a socket (measured: 30 cancels, 30 more descriptors).

const descriptors = (pid: number) =>
  process.platform === 'linux'
    ? readdirSync(`/proc/${pid}/fd`).length
    : execFileSync('lsof', ['-p', String(pid), '-Ff'], { encoding: 'utf8' })
        .split('\n')
        .filter((line) => /^f\d/.test(line)).length

test(
  'stateful HTTP closes a cancelled call’s stream, and later notifications still arrive',
  { timeout: 60000, skip: process.platform === 'win32' },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/helpers/slow-peer.mjs',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const logs: unknown[] = []
    const client = new Client({ name: 'cancel-stream', version: '1.0.0' })
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      logs.push(n.params.data)
    })
    t.after(() => client.close().catch(() => {}))
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
    )
    const before = descriptors(gateway.child.pid!)
    for (let n = 0; n < 20; n++) {
      const abort = new AbortController()
      const call = client.callTool(
        { name: 'slow', arguments: { ms: 60000 } },
        undefined,
        { signal: abort.signal },
      )
      await delay(50)
      abort.abort('cancelled by the test')
      await assert.rejects(call)
    }
    await delay(1000)
    assert.ok(
      descriptors(gateway.child.pid!) <= before + 4,
      'twenty cancelled calls left their streams open',
    )
    // Notifications ride the call in flight; a cancelled call is no longer one.
    await client.callTool({
      name: 'note',
      arguments: { text: 'after the cancels' },
    })
    await gateway.waitFor(() => logs.length > 0, 'deliver the log message')
    assert.deepEqual(logs, ['after the cancels'])
  },
)

test('a cancel closes only a call still in flight, and works without closeSSEStream', async (t) => {
  const b = observeGateway(t)
  const { stdioToStatefulStreamableHttp } = await import(
    '../src/gateways/stdioToStatefulStreamableHttp.js'
  )
  await stdioToStatefulStreamableHttp({
    stdioCmd: 'controlled-peer',
    port: 0,
    streamableHttpPath: '/mcp',
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
    sessionTimeout: null,
  })
  await b.request('POST', '/mcp', { body: initialize(1) })
  const child = b.children[0]
  const transport = b.transports[0]
  child.stdout.emit(
    'data',
    Buffer.from('{"jsonrpc":"2.0","id":1,"result":{}}\n'),
  )
  const cancel = (params?: object) =>
    transport.onmessage!({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      ...(params ? { params } : {}),
    })
  const notify = () =>
    child.stdout.emit(
      'data',
      Buffer.from(
        '{"jsonrpc":"2.0","method":"notifications/message","params":{}}\n',
      ),
    )

  // An SDK before 1.23.1 has no closeSSEStream: the cancel still reaches the
  // child and the call stops receiving notifications.
  transport.onmessage!({ jsonrpc: '2.0', id: 5, method: 'tools/call' })
  cancel({ requestId: 5 })
  assert.match(child.writes.at(-1)!, /notifications\/cancelled/)
  notify()
  assert.deepEqual(transport.sentOptions.at(-1), {
    relatedRequestId: undefined,
  })

  const closed: unknown[] = []
  Object.assign(transport, {
    closeSSEStream: (id: unknown) => closed.push(id),
  })
  transport.onmessage!({ jsonrpc: '2.0', id: 'call-6', method: 'tools/call' })
  cancel({ requestId: 'call-6' })
  cancel({ requestId: 'call-6' })
  cancel({ requestId: 99 })
  cancel()
  assert.deepEqual(
    closed,
    ['call-6'],
    'only a call still in flight is closed, once',
  )
})
