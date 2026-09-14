import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'
import { knownBugTest } from './helpers/known-bug.js'

// Nothing else in the suite connects two clients to one gateway, which is how
// #112, #138 and #153 stayed open: every existing test exercises each gateway
// once, and a bug that needs a *second* connection is invisible to all of them
// no matter how well the first one is covered. `server` is constructed once per
// process in stdioToSse.ts and `server.connect()` is called per connection, so
// the second connection is the whole question.
//
// It asks the wrong one, though, which is why it is held rather than enforced.
// Two clients both reaching the upstream server is not the property that
// matters; both reaching it *without seeing each other's traffic* is. On SDKs
// up to 1.25.3 this test passed — and it passed because those versions do not
// guard the shared-instance reuse that GHSA-345p-7cg4-v4c7 describes, so the
// second client was served by leaking. A green here certified the vulnerable
// configuration as working. From 1.26.0 the SDK refuses the second connect and
// this fails, which is the same defect seen from the other side.
//
// `sseClientIsolation.test.ts` asserts the property this one should have, and
// is the spec for the fix. This stays as the reachability half of GW-017: when
// the fix lands, both are enabled together and both must pass.
knownBugTest(
  'GW-017',
  'SSE gateway serves a second client on the same process',
  { timeout: 30000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = new URL(`http://127.0.0.1:${port}/sse`)

    const connect = async (label: string) => {
      const client = new Client(
        { name: `probe-${label}`, version: '1.0.0' },
        { capabilities: {} },
      )
      const transport = new SSEClientTransport(url)
      // Registered before connecting, not after: when the gateway rejects the
      // second connection the connect call throws, and a transport torn down
      // only on success leaves its request open and the runner never exits.
      t.after(() => transport.close().catch(() => {}))
      t.after(() => client.close().catch(() => {}))
      await client.connect(transport)
      return client
    }

    const first = await connect('first')
    assert.deepEqual(
      (await first.listTools()).tools.map((tool) => tool.name),
      ['add'],
      'the first client reaches the upstream server',
    )

    // The second connection, on the same gateway process, is the actual subject.
    const second = await connect('second')
    assert.deepEqual(
      (await second.listTools()).tools.map((tool) => tool.name),
      ['add'],
      'a second client reaches the upstream server on the same gateway process',
    )

    // Both sessions must still be independently usable afterwards: a gateway
    // that routed the second client by displacing the first would pass the
    // check above and still be broken.
    assert.deepEqual(
      await first.callTool({ name: 'add', arguments: { a: 2, b: 3 } }),
      await second.callTool({ name: 'add', arguments: { a: 2, b: 3 } }),
      'both sessions still serve calls after the second one connects',
    )
    assert.equal(
      gateway.child.exitCode,
      null,
      'the gateway survives a second client',
    )
  },
)
