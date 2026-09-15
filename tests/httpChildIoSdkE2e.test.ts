import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { faultControl } from './helpers/fault-control.js'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

// An HTTP response ending is not a JSON-RPC reply. The SDK can keep a call
// pending after EOF, so require an actual protocol error before its timeout.
for (const stateful of [true, false]) {
  for (const fault of ['spawn', 'stdin'] as const) {
    test(
      `${stateful ? 'stateful' : 'stateless'} SDK receives a protocol error on child ${fault} failure`,
      { timeout: 15000 },
      async (t) => {
        const control = await faultControl(t)
        const port = await unusedPort()
        const gateway = launchGateway(
          t,
          [
            '--stdio',
            'exec node tests/helpers/fault-peer.mjs',
            '--outputTransport',
            'streamableHttp',
            '--port',
            String(port),
            ...(stateful ? ['--stateful'] : []),
          ],
          {
            FAULT_CONTROL: control.url,
            FAULT_INIT: !stateful && fault === 'stdin' ? '1' : '0',
            ...(fault === 'spawn'
              ? {
                  FAIL_SPAWN_AT: '1',
                  NODE_OPTIONS: `--import=${new URL('./helpers/native-spawn-failure.mjs', import.meta.url).href}`,
                }
              : {}),
          },
        )
        await gateway.ready()
        const client = new Client(
          { name: 'io-test', version: '1.0.0' },
          { capabilities: {} },
        )
        const transport = new StreamableHTTPClientTransport(
          new URL(`http://127.0.0.1:${port}/mcp`),
        )
        t.after(() => client.close())
        t.after(() => transport.close())
        const failed = (error: any) => {
          assert.equal(
            error.code,
            -32603,
            'a process error must arrive before the SDK request timeout',
          )
          assert.match(error.message, /MCP server process failed/)
          return true
        }
        if (fault === 'spawn') {
          await assert.rejects(
            client.connect(transport, { timeout: 2500 }),
            failed,
          )
        } else {
          await client.connect(transport)
          const call = (name: string) =>
            client.callTool({ name, arguments: {} }, undefined, {
              timeout: 2500,
            })
          let held: Promise<void> | undefined
          if (stateful) {
            held = assert.rejects(call('hold'), failed)
            // Attach rejection handling while waiting for the independent barrier.
            held.catch(() => {})
            await control.wait('hold')
            await call('closeInput')
          }
          await assert.rejects(call('identity'), failed)
          await held
          await control.wait('stdin-closed')
        }
        assert.equal(gateway.child.exitCode, null)
        assert.equal(gateway.child.signalCode, null)
      },
    )
  }
}
