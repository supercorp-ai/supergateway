import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchGateway, rpc, unusedPort } from './helpers/gateway-process.js'

// Stateless mode gives every request a fresh child and initializes it itself.
// It used --protocolVersion (default 2024-11-05) for every one of them, so a
// client that negotiated 2025-11-25 had each later request served by a child
// that believed the client was on 2024-11-05. From 2025-06-18 on a client names
// its version in every request's MCP-Protocol-Version header; the child now
// gets that one, and --protocolVersion only when the request does not say.
const initializedWith = async (
  url: string,
  headers: Record<string, string>,
) => {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'which', arguments: {} },
    }),
  })
  const text = await response.text()
  assert.equal(response.status, 200, text)
  return text.match(/child initialized with ([\d-]+)/)![1]
}

for (const flag of [undefined, '2025-03-26']) {
  test(
    `stateless HTTP initializes each child with the client's version (--protocolVersion ${flag ?? 'default'})`,
    { timeout: 20000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        'node tests/helpers/version-peer.mjs',
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        ...(flag ? ['--protocolVersion', flag] : []),
      ])
      await gateway.ready()
      const url = `http://127.0.0.1:${port}/mcp`
      for (const version of ['2025-06-18', '2025-11-25'])
        assert.equal(
          await initializedWith(url, { 'mcp-protocol-version': version }),
          version,
        )
      assert.equal(
        await initializedWith(url, {}),
        flag ?? '2024-11-05',
        'a request that names no version gets --protocolVersion',
      )
      // The client's own initialize goes to its child unchanged.
      const init = await rpc(url, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0.0' },
        },
      })
      assert.equal(init.messages[0].result.protocolVersion, '2025-06-18')
    },
  )
}
