import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
// The `ws` client, not the global one: `WebSocket` is undefined on Node 20.
import { WebSocket } from 'ws'
import { initialize, rpc, unusedPort } from './helpers/gateway-process.js'

for (const mode of ['ws', 'stateless']) {
  test(
    `${mode} public gateway handles an empty child-command configuration`,
    { timeout: 10000 },
    async (t) => {
      const port = await unusedPort()
      const child = spawn(
        process.execPath,
        ['tests/helpers/empty-command-gateway.mjs', mode, String(port)],
        { stdio: 'pipe' },
      )
      let output = ''
      let errors = ''
      child.stdout.on('data', (chunk) => {
        output += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        errors += chunk.toString()
      })
      const closed = new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL')
        await closed
      })
      const deadline = Date.now() + 5000
      while (!output.includes(`Listening on port ${port}`)) {
        assert.equal(child.exitCode, null, errors)
        assert.ok(Date.now() < deadline, output + errors)
        await delay(10)
      }
      const url = `http://127.0.0.1:${port}`
      if (mode === 'ws') {
        // The child is spawned per connection, so a command that cannot start
        // refuses each connection, with a reason, and the gateway stays up.
        for (let attempt = 0; attempt < 2; attempt++) {
          const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
          const [code, reason] = await once(socket, 'close')
          assert.equal(code, 1011)
          assert.equal(String(reason), 'MCP server process failed')
        }
        const health = await fetch(url + '/health', {
          signal: AbortSignal.timeout(2000),
        })
        assert.equal(await health.text(), 'ok')
        assert.match(errors, /Failed to start the MCP server.*empty/s)
        assert.doesNotMatch(
          errors,
          /UnhandledPromiseRejection|Cannot read properties/,
        )
        assert.equal(child.exitCode, null)
      } else {
        for (const id of [1, 2]) {
          const result = await rpc(url + '/mcp', initialize(id))
          assert.equal(result.response.status, 500)
          assert.deepEqual(result.messages, [
            {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32603, message: 'Internal server error' },
            },
          ])
        }
        const health = await fetch(url + '/health', {
          signal: AbortSignal.timeout(2000),
        })
        assert.equal(health.status, 200)
        assert.equal(await health.text(), 'ok')
        assert.match(errors, /Error handling MCP request:.*empty/)
        assert.equal(child.exitCode, null)
      }
    },
  )
}
