import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

for (const modern of [false, true]) {
  test(
    `wire fixture preserves Unicode line separators (${modern ? 'modern' : 'legacy'})`,
    { timeout: 5000 },
    async (t) => {
      const peer = spawn(
        process.execPath,
        ['tests/helpers/modern-bridge-peer.mjs'],
        {
          env: { ...process.env, MODERN_WIRE: modern ? '1' : '0' },
          stdio: 'pipe',
        },
      )
      t.after(() => {
        peer.kill()
      })
      let output = '',
        errors = ''
      peer.stdout.setEncoding('utf8').on('data', (chunk) => {
        output += chunk
      })
      peer.stderr.setEncoding('utf8').on('data', (chunk) => {
        errors += chunk
      })
      const closed = once(peer, 'close')
      const value = 'before\u2028middle\u2029after 🌙 漢字'
      const request =
        JSON.stringify({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: {
            name: 'echo',
            arguments: { value },
            _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
          },
        }) + '\n'
      // Also split the UTF-8 bytes across writes, including multi-byte characters.
      const bytes = Buffer.from(request)
      for (let index = 0; index < bytes.length; index++)
        peer.stdin.write(bytes.subarray(index, index + 1))
      peer.stdin.end()
      const [code] = await closed
      assert.equal(code, 0, errors)
      const reply = JSON.parse(output)
      assert.equal(reply.id, 7)
      assert.deepEqual(reply.result.content, [{ type: 'text', text: value }])
      assert.deepEqual(reply.result.structuredContent, { value })
      if (modern) assert.equal(reply.result.resultType, 'complete')
    },
  )
}
