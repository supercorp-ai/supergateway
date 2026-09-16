import { knownBugTest } from './helpers/known-bug.js'
import assert from 'node:assert/strict'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

// Release-blocking checks for the transparent-relay experiment. These exercise
// HTTP requirements separately from the direct-versus-wrapped stdio controls.
const version = '2026-07-28'
for (const [label, method, params, headers, status, code] of [
  [
    'missing method header',
    'server/discover',
    {},
    { 'mcp-method': '' },
    400,
    -32020,
  ],
  [
    'mismatched tool name',
    'tools/call',
    { name: 'inspect', arguments: {} },
    { 'mcp-name': 'different' },
    400,
    -32020,
  ],
  [
    'missing protocol header',
    'server/discover',
    {},
    { 'mcp-protocol-version': '' },
    400,
    -32020,
  ],
  [
    'unsupported protocol',
    'server/discover',
    {},
    { 'mcp-protocol-version': '2099-01-01' },
    400,
    -32022,
  ],
  ['unknown RPC method', 'not/implemented', {}, {}, 404, -32601],
] as const) {
  knownBugTest(
    'PR-193 transparent HTTP validation',
    `modern relay edge: ${label}`,
    { timeout: 15000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        'node tests/helpers/transparent-sdk-peer.mjs --modern-only',
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
      ])
      await gateway.ready()
      const requestHeaders = new Headers({
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        'mcp-method': method,
        ...('name' in params ? { 'mcp-name': params.name } : {}),
        ...headers,
      })
      for (const [name, value] of requestHeaders)
        if (value === '') requestHeaders.delete(name)
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: requestHeaders,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'opaque-id',
          method,
          params: {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion':
                label === 'unsupported protocol' ? '2099-01-01' : version,
              'io.modelcontextprotocol/clientInfo': {
                name: 'edge-control',
                version: '1',
              },
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          },
        }),
      })
      const body = await response.json()
      assert.deepEqual(
        { status: response.status, id: body.id, code: body.error?.code },
        { status, id: 'opaque-id', code },
      )
    },
  )
}
