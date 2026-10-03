import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayTimeout,
  launchGateway,
  unusedPort,
} from './helpers/gateway-process.js'

// A stateful session whose server fails at startup is forgotten while the
// client's initialize response is still open. That response ending used to
// lower a count the session no longer had, and log it as an error.

for (const [label, server] of [
  [
    'a local server that cannot start',
    ['--stdio', 'supergateway-no-such-command'],
  ],
  [
    'a remote server that is down',
    ['--streamableHttp', 'http://127.0.0.1:1/mcp'],
  ],
] as const)
  test(
    `${label}: its session's response ends without a counting error`,
    { timeout: gatewayTimeout(30000) },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        ...server,
        '--outputTransport',
        'streamableHttp',
        '--stateful',
        '--sessionTimeout',
        '60000',
        '--port',
        String(port),
      ])
      await gateway.ready()
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'test', version: '1.0.0' },
          },
        }),
      })
      // The client is told the server failed.
      assert.match(await response.text(), /"id":1,"error":/)
      await gateway.waitFor(
        () => /Response (finished|closed)/.test(gateway.output()),
        'end the response',
      )
      const log = gateway.output() + gateway.errors()
      assert.match(log, /SessionAccessCounter\.clear\(\) [\w-]+, caused by/)
      assert.doesNotMatch(log, /Called dec\(\) on non-existent session/)
    },
  )
