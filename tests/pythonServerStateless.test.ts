import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { launchGateway, rpc, unusedPort } from './helpers/gateway-process.js'

// #85: a Python MCP server answers nothing before its initialize handshake, and
// the stateless gateway spawns a fresh one for every request. The gateway has to
// initialize each child itself before forwarding the client's request.
const python = process.env.SUPERGATEWAY_TEST_PYTHON ?? 'python3'
const available = (() => {
  try {
    execFileSync(python, ['-c', 'import mcp'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()
// CI sets this where Python is installed, so a broken setup fails instead of skipping.
if (process.env.SUPERGATEWAY_REQUIRE_PYTHON === '1' && !available)
  throw new Error(`${python} cannot import mcp`)

test(
  'stateless HTTP serves a Python MCP server without a client initialize (#85)',
  {
    timeout: 60000,
    skip: available ? false : `${python} has no mcp package`,
  },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      `${python} tests/helpers/python-mcp-server.py`,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const url = `http://127.0.0.1:${port}/mcp`

    const listed = await rpc(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    })
    assert.equal(listed.response.status, 200)
    assert.deepEqual(
      listed.messages
        .find((message) => message.id === 1)
        .result.tools.map((tool: { name: string }) => tool.name),
      ['add'],
    )

    const called = await rpc(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'add', arguments: { a: 2, b: 3 } },
    })
    assert.equal(called.response.status, 200)
    assert.equal(
      called.messages.find((message) => message.id === 2).result.content[0]
        .text,
      'The sum of 2 and 3 is 5.',
    )
    assert.equal(gateway.child.exitCode, null)
  },
)
