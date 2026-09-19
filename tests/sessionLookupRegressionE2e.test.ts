import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * GW-008. The session registry used to be a plain object, so a session id that
 * names something on `Object.prototype` resolved to an inherited function and
 * was then used as a transport. `transport.handleRequest is not a function`
 * killed the gateway — from an ordinary HTTP header, with no session ever
 * created, and therefore available to anyone who can reach the port.
 *
 * The original report claimed only `constructor`. Sweeping the rest of the
 * prototype found all twelve behave the same way, which is why the fix is a
 * `Map` rather than a check for the names: the defect is the lookup, not the
 * list.
 *
 * Every name is driven through the real CLI over HTTP. Nothing is mocked and no
 * prototype is mutated — these are just strings in a header.
 */
const INHERITED = [
  'constructor',
  '__proto__',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__lookupGetter__',
  '__defineSetter__',
  '__lookupSetter__',
]

for (const method of ['POST', 'GET', 'DELETE']) {
  test(
    `stateful HTTP rejects every inherited-property session ID for ${method}`,
    { timeout: 20000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--stateful',
        '--port',
        String(port),
        '--healthEndpoint',
        '/health',
      ])
      await gateway.ready()
      const base = `http://127.0.0.1:${port}`

      for (const sessionId of INHERITED) {
        const response = await fetch(base + '/mcp', {
          method,
          signal: AbortSignal.timeout(3000),
          headers: {
            'mcp-session-id': sessionId,
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          ...(method === 'POST'
            ? {
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
              }
            : {}),
        }).catch((cause) => {
          throw new Error(
            `${method} with session id ${sessionId} killed the gateway: ${gateway.errors()}`,
            { cause },
          )
        })
        assert.equal(
          response.status,
          404,
          `${sessionId} must be rejected as an unknown session`,
        )
        await response.text()
      }

      // The gateway is still serving afterwards, not merely still a process:
      // the crash this pins took the whole listener with it.
      const health = await fetch(base + '/health', {
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(health.status, 200)
      assert.equal(await health.text(), 'ok')
      assert.equal(gateway.child.exitCode, null)
    },
  )
}
