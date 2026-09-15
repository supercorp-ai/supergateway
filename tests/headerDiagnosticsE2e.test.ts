import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

/**
 * GW-006, fixed. These three gateways used to write
 * `Object(headers).length`, which is `undefined` for any ordinary object and
 * therefore always falsy, so every configured header was reported as `(none)`.
 *
 * The obvious-looking repair — `headers.length` — would have been worse than
 * the bug: `length` is a legal header name, and `headerNamesE2e.test.ts` passes
 * one. Only `Object.keys(headers).length` is correct, and the second case below
 * is what holds that.
 */
for (const mode of ['sse', 'stateful', 'stateless']) {
  const gatewayArgs = (port: number, extra: string[]) => [
    '--stdio',
    peerCommand,
    '--outputTransport',
    mode === 'sse' ? 'sse' : 'streamableHttp',
    '--port',
    String(port),
    ...extra,
    ...(mode === 'stateful' ? ['--stateful'] : []),
  ]

  test(
    `${mode} startup reports configured headers`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        gatewayArgs(port, ['--header', 'X-Audit: configured']),
      )
      await gateway.ready()
      assert.match(gateway.output(), /Headers: \{"X-Audit":"configured"\}/)
    },
  )

  test(
    `${mode} startup reports no headers as none`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, gatewayArgs(port, []))
      await gateway.ready()
      assert.match(gateway.output(), /Headers: \(none\)/)
    },
  )

  test(
    `${mode} startup reports a header named length`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        gatewayArgs(port, ['--header', 'length: custom-value']),
      )
      await gateway.ready()
      assert.match(gateway.output(), /Headers: \{"length":"custom-value"\}/)
    },
  )
}
