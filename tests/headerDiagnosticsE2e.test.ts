import assert from 'node:assert/strict'
import { knownBugTest } from './helpers/known-bug.js'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

for (const mode of ['sse', 'stateful', 'stateless']) {
  knownBugTest(
    'GW-006',
    `${mode} startup reports configured headers`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        mode === 'sse' ? 'sse' : 'streamableHttp',
        '--port',
        String(port),
        '--header',
        'X-Audit: configured',
        ...(mode === 'stateful' ? ['--stateful'] : []),
      ])
      await gateway.ready()
      assert.match(gateway.output(), /Headers: \{"X-Audit":"configured"\}/)
    },
  )
}
