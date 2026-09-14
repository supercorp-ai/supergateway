import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import {
  initialize,
  launchGateway,
  stdioRpc,
} from './helpers/gateway-process.js'
import {
  errorDetails,
  shadowResult,
  wireUpstream,
} from './helpers/wire-mcp-upstream.js'
import { knownBugTest } from './helpers/known-bug.js'

async function connect(t: TestContext, protocol: string) {
  const peer = await wireUpstream(t)
  const bridge = launchGateway(t, [
    `--${protocol}`,
    `${peer.base}/${protocol === 'sse' ? 'sse' : 'mcp'}`,
  ])
  await bridge.ready()
  const init = await stdioRpc(bridge, initialize(100))
  assert.equal(init.result.serverInfo.name, 'wire-peer')
  return bridge
}

const call = (id: number, name: string, args = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
})

for (const protocol of ['sse', 'streamableHttp']) {
  test(
    `${protocol} ignores malformed event responses and preserves later reply correlation`,
    { timeout: 15000 },
    async (t) => {
      const bridge = await connect(t, protocol)
      const recovered = await stdioRpc(bridge, call(101, 'malformed-events'))
      assert.deepEqual(recovered, {
        jsonrpc: '2.0',
        id: 101,
        result: { content: [{ type: 'text', text: 'recovered' }] },
      })
      const failure = await stdioRpc(bridge, call(102, 'failure'))
      assert.deepEqual(failure, {
        jsonrpc: '2.0',
        id: 102,
        error: { code: -32042, message: 'Invalid query' },
      })
      const later = await stdioRpc(bridge, {
        jsonrpc: '2.0',
        id: 103,
        method: 'tools/list',
      })
      assert.deepEqual(later.result, { tools: [] })
      const replies = bridge
        .output()
        .split('\n')
        .filter((line) => line.startsWith('{'))
        .map((line) => JSON.parse(line))
      assert.deepEqual(
        replies.map((reply) => reply.id),
        [100, 101, 102, 103],
      )
      assert.equal(bridge.child.exitCode, null)
    },
  )

  knownBugTest(
    'GW-011',
    `${protocol} preserves a successful result with a hasOwnProperty extension`,
    { timeout: 15000 },
    async (t) => {
      const bridge = await connect(t, protocol)
      const result = await stdioRpc(bridge, call(101, 'shadow'))
      assert.deepEqual(result, {
        jsonrpc: '2.0',
        id: 101,
        result: shadowResult,
      })
      assert.deepEqual(
        (
          await stdioRpc(bridge, {
            jsonrpc: '2.0',
            id: 102,
            method: 'tools/list',
          })
        ).result,
        { tools: [] },
      )
      assert.equal(bridge.child.exitCode, null)
    },
  )

  knownBugTest(
    'GW-012',
    `${protocol} preserves upstream error details`,
    { timeout: 15000 },
    async (t) => {
      const bridge = await connect(t, protocol)
      const failure = await stdioRpc(bridge, call(101, 'error-data'))
      assert.deepEqual(failure, {
        jsonrpc: '2.0',
        id: 101,
        error: { code: -32042, message: 'Invalid query', data: errorDetails },
      })
    },
  )
}

test(
  'HTTP bridge rejects malformed JSON error envelopes and remains usable',
  { timeout: 15000 },
  async (t) => {
    const bridge = await connect(t, 'streamableHttp')
    for (const variant of [0, 1, 2]) {
      const failure = await stdioRpc(
        bridge,
        call(101 + variant, 'malformed-json', { variant }),
      )
      assert.equal(failure.result, undefined)
      assert.equal(failure.error.code, -32000)
      assert.equal(typeof failure.error.message, 'string')
      assert.ok(failure.error.message.length > 0)
    }
    assert.deepEqual(
      (
        await stdioRpc(bridge, {
          jsonrpc: '2.0',
          id: 104,
          method: 'tools/list',
        })
      ).result,
      { tools: [] },
    )
    assert.equal(bridge.child.exitCode, null)
  },
)
