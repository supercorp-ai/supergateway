import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * A client's `notifications/cancelled` names the client's own request id, and
 * the bridges send upstream under ids their SDK `Client` picks. Relayed
 * unchanged, a cancel only worked when the two numberings happened to agree —
 * the SDK client counts from 0 just like the bridge — and with string ids it
 * reached nothing: the tool ran to the end and the client got a reply for a
 * call it had cancelled.
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
    `${kind.flag} bridge cancels the request the client named`,
    { timeout: 30000 },
    async (t) => {
      const port = await unusedPort()
      const upstream = launchGateway(t, [
        '--stdio',
        'node tests/helpers/slow-peer.mjs',
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
      const reply = async (id: string) => {
        await bridge.waitFor(
          () => replies().some((m) => m.id === id),
          `answer ${id}`,
        )
        return replies().find((m) => m.id === id)
      }
      const send = (message: object) =>
        bridge.child.stdin.write(
          JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n',
        )

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

      // String ids: nothing like the bridge's own numbering.
      send({
        id: 'call-A',
        method: 'tools/call',
        params: { name: 'slow', arguments: { ms: 1500 } },
      })
      await delay(300)
      send({
        method: 'notifications/cancelled',
        params: { requestId: 'call-A', reason: 'user stopped it' },
      })
      await delay(300)
      send({
        id: 'status',
        method: 'tools/call',
        params: { name: 'status', arguments: {} },
      })
      assert.equal(
        (await reply('status')).result.content[0].text,
        'aborted',
        'the server received the cancellation',
      )

      // Past the point the tool would have finished on its own.
      await delay(1700)
      assert.equal(
        replies().some((m) => m.id === 'call-A'),
        false,
        'a cancelled request gets no reply',
      )
    },
  )
}
