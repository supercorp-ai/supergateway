import { test } from 'node:test'
import assert from 'node:assert/strict'
import { knownBugTest } from './helpers/known-bug.js'
import {
  launchGateway,
  peerCommand,
  rpc,
  unusedPort,
} from './helpers/gateway-process.js'

for (const notification of [true, false]) {
  const runTest = notification ? test : knownBugTest.bind(undefined, 'GW-009')
  runTest(
    `stateless HTTP contains deeply nested ${notification ? 'malformed notification' : 'request'} failures`,
    { timeout: 15000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--outputTransport',
        'streamableHttp',
        '--port',
        String(port),
        '--healthEndpoint',
        '/health',
      ])
      await gateway.ready()
      const base = `http://127.0.0.1:${port}`
      // Valid JSON below the HTTP body-size limit, built as wire text so the
      // test client does not need to recursively serialize the nested value.
      const nested = '['.repeat(20000) + '0' + ']'.repeat(20000)
      const body = `{"jsonrpc":"2.0",${notification ? '' : '"id":2,'}"method":"${notification ? 'notifications/progress' : 'tools/list'}","params":{"extra":${nested}}}`
      const response = await fetch(base + '/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body,
        signal: AbortSignal.timeout(5000),
      }).catch(async (cause) => {
        const health = await fetch(base + '/health', {
          signal: AbortSignal.timeout(2000),
        }).catch(() => undefined)
        const status = health?.status
        await health?.text()
        throw new Error(
          `Health after failure: ${status}\n${gateway.errors()}`,
          {
            cause,
          },
        )
      })
      // This is failure-containment coverage, not a promise of unlimited
      // nesting support or of delivering an unsupported notification.
      assert.ok(
        response.status === (notification ? 202 : 200) ||
          response.status === 400 ||
          response.status === 413,
        `unexpected HTTP status ${response.status}: ${gateway.errors()}`,
      )
      const responseBody = await response.text()
      if (!notification && response.status === 200) {
        const replies = responseBody
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => JSON.parse(line.slice(5)))
        assert.ok(
          replies.some(
            (message) =>
              message.id === 2 &&
              message.result?.tools.some(
                (tool: { name: string }) => tool.name === 'add',
              ),
          ),
        )
      }
      const health = await fetch(base + '/health', {
        signal: AbortSignal.timeout(2000),
      })
      assert.equal(health.status, 200)
      await health.text()
      const later = await rpc(base + '/mcp', {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/list',
      })
      assert.equal(later.response.status, 200)
      assert.ok(
        later.messages
          .find((message) => message.id === 3)
          .result.tools.some((tool: { name: string }) => tool.name === 'add'),
      )
      assert.equal(gateway.child.exitCode, null)
    },
  )
}
