import { test } from 'node:test'
import assert from 'node:assert/strict'
import { constants } from 'node:buffer'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

for (const value of [
  '0',
  '-1',
  '1.5',
  'NaN',
  'Infinity',
  String(constants.MAX_STRING_LENGTH + 1),
]) {
  test(
    `CLI rejects invalid stdout line limit ${value}`,
    { timeout: 15000 },
    async (t) => {
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        `--maxStdoutLineBytes=${value}`,
      ])
      assert.deepEqual(await gateway.exited, { code: 1, signal: null })
      assert.match(
        gateway.errors(),
        new RegExp(
          `maxStdoutLineBytes must be an integer between 1 and ${constants.MAX_STRING_LENGTH}`,
        ),
      )
      assert.doesNotMatch(gateway.output(), /Listening on port/)
    },
  )
}
for (const value of [1, constants.MAX_STRING_LENGTH]) {
  test(
    `CLI accepts stdout line limit boundary ${value}`,
    { timeout: 15000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--port',
        String(port),
        '--maxStdoutLineBytes',
        String(value),
        '--healthEndpoint',
        '/health',
      ])
      await gateway.ready()
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), 'ok')
      assert.equal(gateway.child.exitCode, null)
    },
  )
}
