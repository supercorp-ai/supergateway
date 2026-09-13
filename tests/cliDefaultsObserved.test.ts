import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

const cases = [
  {
    name: 'stdio default',
    input: ['--stdio', peerCommand],
    output: 'sse',
    extra: [],
    diagnostic: 'SSE endpoint:',
  },
  {
    name: 'SSE default',
    input: ['--sse', 'http://127.0.0.1:54321/events'],
    output: 'stdio',
    extra: [],
    diagnostic: 'Connecting to SSE...',
  },
  {
    name: 'HTTP default',
    input: ['--streamableHttp', 'http://127.0.0.1:54321/mcp'],
    output: 'stdio',
    extra: [],
    diagnostic: 'Connecting to Streamable HTTP...',
  },
  {
    name: 'stateful timeout',
    input: ['--stdio', peerCommand],
    output: 'streamableHttp',
    extra: [
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--sessionTimeout',
      '250',
    ],
    diagnostic: '  - Session timeout: 250ms',
  },
  {
    name: 'stateful without timeout',
    input: ['--stdio', peerCommand],
    output: 'streamableHttp',
    extra: ['--outputTransport', 'streamableHttp', '--stateful'],
    diagnostic: '  - Session timeout: disabled',
  },
  {
    name: 'stateless explicit',
    input: ['--stdio', peerCommand],
    output: 'streamableHttp',
    extra: ['--outputTransport', 'streamableHttp'],
    diagnostic: 'Running stateless server',
  },
]
for (const item of cases) {
  test(
    `CLI ${item.name} selects and announces the expected transport`,
    { timeout: 15000 },
    async (t) => {
      const gateway = launchGateway(t, [
        ...item.input,
        ...item.extra,
        '--port',
        String(await unusedPort()),
      ])
      await gateway.ready()
      if (item.name === 'stdio default') {
        // Readiness is announced before the two endpoint lines. Wait for the
        // last record on that stream before checking the preceding endpoint.
        await gateway.waitFor(
          () => gateway.output().includes('POST messages:'),
          'finish announcing the SSE listener',
        )
      }
      const output = gateway.output() + gateway.errors()
      // map: selected-transport
      assert.ok(
        output.includes(`[supergateway]   - outputTransport: ${item.output}\n`),
      )
      // map: selected-gateway
      assert.ok(output.includes(item.diagnostic))
      // map: banner
      assert.ok(
        output.includes('[supergateway] Starting...\n') &&
          output.includes(
            'Supergateway is supported by Supermachine (hosted MCPs) - https://supermachine.ai',
          ),
      )
    },
  )
}
