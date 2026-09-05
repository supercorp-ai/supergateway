import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
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
      if (mode === 'ws') {
        assert.equal(await closed, 1)
        assert.match(errors, /Failed to start:.*empty/)
        assert.doesNotMatch(
          errors,
          /UnhandledPromiseRejection|Cannot read properties/,
        )
      } else {
        const deadline = Date.now() + 5000
        while (!output.includes(`Listening on port ${port}`)) {
          assert.equal(child.exitCode, null, errors)
          assert.ok(Date.now() < deadline, output + errors)
          await delay(10)
        }
        const url = `http://127.0.0.1:${port}`
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
