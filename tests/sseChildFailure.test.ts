import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'
import { lifecycleControl, within } from './helpers/lifecycle-control.js'

// A child that exited with calls in flight ended its SSE session silently, and
// the client waited out its own timeout on each call (60 seconds by default;
// measured with 10s). Stateful HTTP answered at once. The call now fails
// straight away with the same error.
test(
  'SSE fails a call in flight when its server exits',
  { timeout: 20000 },
  async (t) => {
    const control = await lifecycleControl(t)
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      control.peerCommand,
      '--outputTransport',
      'sse',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const client = new Client({ name: 'sse-child-failure', version: '1.0.0' })
    t.after(() => client.close().catch(() => {}))
    await client.connect(
      new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)),
    )
    const call = client.callTool({ name: 'hold', arguments: {} }, undefined, {
      timeout: 15000,
    })
    call.catch(() => {})
    const held = await control.started
    const started = Date.now()
    held.end('exit')
    await within(
      assert.rejects(call, /MCP server process failed/),
      'fail the call in flight',
    )
    assert.ok(
      Date.now() - started < 5000,
      'the call failed promptly, not at its own timeout',
    )
  },
)
