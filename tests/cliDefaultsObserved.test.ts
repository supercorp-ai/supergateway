import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  launchGateway,
  peerCommand,
  unusedPort,
} from './helpers/gateway-process.js'

const prefix = '[supergateway] '
const banner =
  'Supergateway is supported by Supermachine (hosted MCPs) - https://supermachine.ai'

// Each case names the announcement family it cares about (`select`) and the
// complete line that family must contain (`expect`). Selecting the family and
// comparing the whole list keeps a second, contradictory announcement from
// passing the way a substring search would.
const cases = [
  {
    name: 'stdio default',
    input: ['--stdio', peerCommand],
    output: 'sse',
    extra: [],
    select: 'SSE endpoint:',
    expect: (port: number) => `SSE endpoint: http://localhost:${port}/sse`,
  },
  {
    name: 'SSE default',
    input: ['--sse', 'http://127.0.0.1:54321/events'],
    output: 'stdio',
    extra: [],
    select: 'Connecting to SSE',
    expect: () => 'Connecting to SSE...',
  },
  {
    name: 'HTTP default',
    input: ['--streamableHttp', 'http://127.0.0.1:54321/mcp'],
    output: 'stdio',
    extra: [],
    select: 'Connecting to Streamable HTTP',
    expect: () => 'Connecting to Streamable HTTP...',
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
    select: '  - Session timeout:',
    expect: () => '  - Session timeout: 250ms',
  },
  {
    name: 'stateful without timeout',
    input: ['--stdio', peerCommand],
    output: 'streamableHttp',
    extra: ['--outputTransport', 'streamableHttp', '--stateful'],
    select: '  - Session timeout:',
    expect: () => '  - Session timeout: disabled',
  },
  {
    name: 'stateless explicit',
    input: ['--stdio', peerCommand],
    output: 'streamableHttp',
    extra: ['--outputTransport', 'streamableHttp'],
    select: 'Running stateless',
    expect: () => 'Running stateless server',
  },
]
for (const item of cases) {
  test(
    `CLI ${item.name} selects and announces the expected transport`,
    { timeout: 15000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        ...item.input,
        ...item.extra,
        '--port',
        String(port),
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
      const lines = [gateway.output(), gateway.errors()]
        .join('\n')
        .split('\n')
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length))
      // map: selected-transport
      assert.deepEqual(
        lines.filter((line) => line.startsWith('  - outputTransport:')),
        [`  - outputTransport: ${item.output}`],
        'the resolved output transport is announced exactly once, and nothing announces a competing one',
      )
      // map: selected-gateway
      assert.deepEqual(
        lines.filter((line) => line.startsWith(item.select)),
        [item.expect(port)],
        'the selected gateway announces itself exactly once, with its full configured detail',
      )
      // map: banner
      assert.deepEqual(
        lines.filter((line) => line === 'Starting...' || line === banner),
        ['Starting...', banner],
        'startup emits the banner once, with the attribution following the start line',
      )
    },
  )
}
