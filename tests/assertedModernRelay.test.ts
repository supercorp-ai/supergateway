import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

// The modern (2026-07-28) relay, end to end against the built CLI: requests it
// rejects before starting a server leave the gateway serving, and a server
// whose tools/list fails costs the caller an internal error while the
// operator's log says why.

const VERSION = '2026-07-28'
const meta = {
  'io.modelcontextprotocol/protocolVersion': VERSION,
  'io.modelcontextprotocol/clientInfo': { name: 'asserted', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
}
const options = { timeout: gatewayTimeout(20000) }

const start = async (t: TestContext, command: string, extra: string[]) => {
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      command,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      ...extra,
    ],
    { MODERN_WIRE: '1' },
  )
  await gateway.ready()
  return { gateway, url: `http://127.0.0.1:${port}/mcp` }
}

const call = async (
  url: string,
  name: string,
  headers: Record<string, string> = {},
) => {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(requestTimeout(5000)),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': VERSION,
      'mcp-method': 'tools/call',
      'mcp-name': name,
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { _meta: meta, name, arguments: {} },
    }),
  })
  const text = await response.text()
  const message = text.startsWith('event:')
    ? JSON.parse(
        text
          .split('\n')
          .find((line) => line.startsWith('data:'))!
          .slice(5),
      )
    : JSON.parse(text)
  return { status: response.status, message }
}

for (const stateful of [false, true]) {
  const label = stateful ? 'stateful' : 'stateless'
  test(
    `${label}: modern requests rejected before dispatch leave the gateway serving`,
    options,
    async (t) => {
      const { gateway, url } = await start(
        t,
        'node tests/helpers/modern-bridge-peer.mjs',
        stateful ? ['--stateful'] : [],
      )
      const rejections = [
        await call(url, 'identity', { 'mcp-name': 'different' }),
        await call(url, 'identity', { 'content-type': 'text/plain' }),
        await call(url, 'identity', { accept: 'application/json' }),
      ]
      // map: rejections
      assert.deepEqual(rejections, [
        {
          status: 400,
          message: {
            jsonrpc: '2.0',
            id: 9,
            error: {
              code: -32020,
              message:
                'Request header mcp-name does not match the request body',
            },
          },
        },
        {
          status: 415,
          message: {
            jsonrpc: '2.0',
            // A body that is not JSON is never parsed, so it has no ID.
            id: null,
            error: {
              code: -32000,
              message: 'Content-Type must be application/json',
            },
          },
        },
        {
          status: 406,
          message: {
            jsonrpc: '2.0',
            id: 9,
            error: {
              code: -32000,
              message:
                'Client must accept application/json and text/event-stream',
            },
          },
        },
      ])
      const served = await call(url, 'identity')
      // map: still-serving
      assert.equal(served.status, 200)
      assert.equal(served.message.id, 9)
      assert.equal(served.message.result.content[0].type, 'text')
      // map: no-fallthrough
      assert.deepEqual(
        { exitCode: gateway.child.exitCode, errors: gateway.errors() },
        { exitCode: null, errors: '' },
      )
    },
  )
}

test(
  "a failing tools/list ends the call with an internal error and logs the server's reason",
  options,
  async (t) => {
    const { gateway, url } = await start(
      t,
      'node tests/helpers/failing-tools-list-peer.mjs',
      [],
    )
    // map: caller-error
    assert.deepEqual(await call(url, 'any'), {
      status: 200,
      message: {
        jsonrpc: '2.0',
        id: 9,
        error: { code: -32603, message: 'MCP server process failed' },
      },
    })
    const reason =
      '[supergateway] MCP child request failed: Error: tools/list failed: tool listing unavailable'
    await gateway.waitFor(
      () => gateway.errors().includes(reason),
      "log the server's tools/list failure",
    )
    // map: operator-reason
    assert.ok(gateway.errors().includes(reason))
    // map: reason-private
    assert.equal(
      gateway.output().includes('tool listing unavailable'),
      false,
      'the reason goes to the error log only',
    )
  },
)
