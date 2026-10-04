import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayTimeout,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * A bridge tracks each request it forwards so the client can cancel it
 * (CancellableRequests), and has to stop tracking it once it is answered.
 * #272 lost that on the success path in both bridges: every request that
 * succeeded stayed in the map for the life of the process, about 150 bytes
 * each, and a client's late `notifications/cancelled` for an answered request
 * was taken for a live one instead of being ignored as the spec asks. The log
 * is where the difference shows: an ignored cancellation says so, and one
 * that found something to abort says nothing.
 */
const BRIDGES = [
  { flag: '--sse', path: '/sse', upstream: ['--outputTransport', 'sse'] },
  {
    flag: '--streamableHttp',
    path: '/mcp',
    upstream: ['--outputTransport', 'streamableHttp', '--stateful'],
  },
] as const

for (const kind of BRIDGES) {
  test(
    `${kind.flag} bridge stops tracking a request once it is answered`,
    { timeout: gatewayTimeout(30000) },
    async (t) => {
      const port = await unusedPort()
      const upstream = launchGateway(t, [
        '--stdio',
        'node tests/helpers/mock-mcp-server.js stdio',
        '--port',
        String(port),
        ...kind.upstream,
      ])
      await upstream.ready()
      const bridge = launchGateway(t, [
        kind.flag,
        `http://127.0.0.1:${port}${kind.path}`,
      ])
      await bridge.ready()
      const replies = () =>
        bridge
          .output()
          .split('\n')
          .filter((line) => line.startsWith('{'))
          .map((line) => JSON.parse(line))
      const reply = (id: string) =>
        bridge.waitFor(() => replies().some((m) => m.id === id), `answer ${id}`)
      const send = (message: object) =>
        bridge.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n',
        )
      // Each log entry, with the message object printed after it.
      const ignored = () =>
        bridge
          .errors()
          .split('[supergateway]')
          .filter((entry) => entry.includes('Ignored a cancellation'))

      send({
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'raw', version: '1.0.0' },
        },
      })
      await reply('init')
      send({ method: 'notifications/initialized' })
      send({ id: 'list', method: 'tools/list' })
      await reply('list')

      send({
        method: 'notifications/cancelled',
        params: { requestId: 'list', reason: 'after its reply' },
      })
      // A request that never existed: once its cancellation is logged, the
      // one before it has been handled too.
      send({
        method: 'notifications/cancelled',
        params: { requestId: 'never', reason: 'control' },
      })
      await bridge.waitFor(
        () => ignored().some((entry) => entry.includes("'never'")),
        'ignore the cancellation of a request that never existed',
      )
      assert.ok(
        ignored().some((entry) => entry.includes("'list'")),
        'the cancellation of an answered request is ignored too',
      )
    },
  )
}
