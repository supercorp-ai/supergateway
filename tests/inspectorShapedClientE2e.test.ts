import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { spawn } from 'node:child_process'
import {
  launchGateway,
  unusedPort,
  gatewayTimeout,
} from './helpers/gateway-process.js'
import { descendantsOf } from './helpers/process-tree.js'

/**
 * What a real client does, which the soak's peers never did.
 *
 * Both defects this covers were found by hand with MCP Inspector after six
 * hours of soak across twelve platform/version combinations had passed clean:
 * the soak's clients always shut down politely, and its peers share their
 * assumptions with the gateway.
 *
 *   1. the bridges wrote every non-request frame to stdout, so a client's
 *      `notifications/initialized` came back to that client and never reached
 *      the server
 *   2. a stateful session's child outlived a client that vanished without
 *      deleting its session, one process per disconnect, for the life of the
 *      gateway
 */
test(
  'a client that notifies and then vanishes is neither echoed to nor leaks its child',
  { timeout: gatewayTimeout(60000) },
  async (t) => {
    const port = await unusedPort()
    const entry = process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js'
    // A short timeout stands in for the default: the point is that *some*
    // bound exists, not the particular number the CLI picks.
    const upstream = launchGateway(t, [
      '--stdio',
      'node tests/helpers/mock-mcp-server.js stdio',
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
      '--sessionTimeout',
      '3000',
    ])
    await upstream.ready()

    // The bridge the client actually runs, driven exactly as a stdio client
    // drives it: initialize, the initialized notification, one real call.
    const bridge = spawn(
      process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath,
      [entry, '--streamableHttp', `http://127.0.0.1:${port}/mcp`],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    t.after(() => {
      try {
        bridge.kill('SIGKILL')
      } catch {
        // Already gone; the assertions below are what matter.
      }
    })
    let down = ''
    bridge.stdout.setEncoding('utf8').on('data', (chunk) => {
      down += chunk
    })
    bridge.stderr.on('data', () => {})
    const send = (message: unknown) =>
      bridge.stdin.write(JSON.stringify(message) + '\n')

    const frames = () =>
      down
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line))
    const settle = async (predicate: () => boolean, description: string) => {
      const deadline = Date.now() + gatewayTimeout(20000)
      while (!predicate()) {
        assert.ok(Date.now() < deadline, description)
        await delay(50)
      }
    }

    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'inspector-shaped', version: '1' },
      },
    })
    await settle(
      () => frames().some((frame) => frame.id === 1),
      'the bridge never answered initialize',
    )
    send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    await settle(
      () => frames().some((frame) => frame.id === 2),
      'the bridge never answered tools/list',
    )

    // Nothing the server sends may be `notifications/initialized`; that is a
    // client→server notification, and seeing one here means the bridge handed
    // the client back its own message.
    assert.deepEqual(
      frames().filter((frame) => frame.method !== undefined),
      [],
      'the bridge sent the client a message that was not a reply to its request',
    )
    assert.deepEqual(
      frames().map((frame) => frame.id),
      [1, 2],
      'exactly the two replies the client asked for',
    )

    // The session is live and owns a child.
    const busy = descendantsOf(upstream.child.pid!, {
      since: upstream.spawnedAt,
    }).length
    assert.ok(busy > 0, 'the session started a child to serve the call')

    // Now vanish the way a crashed or force-quit client does: no session
    // DELETE, no shutdown, just gone.
    bridge.kill('SIGKILL')
    await settle(
      () =>
        descendantsOf(upstream.child.pid!, { since: upstream.spawnedAt })
          .length < busy,
      'the abandoned session never released its child',
    )
  },
)
