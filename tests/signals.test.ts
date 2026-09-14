import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

for (const cleanup of [true, false]) {
  for (const shutdown of ['SIGINT', 'SIGTERM', 'SIGHUP', 'EOF'] as const) {
    test(
      `shutdown public API ${shutdown} with cleanup=${cleanup}`,
      { timeout: 5000 },
      async (t) => {
        const owner = spawn(
          process.execPath,
          ['tests/helpers/signal-owner.mjs', cleanup ? 'cleanup' : 'none'],
          { stdio: 'pipe' },
        )
        t.after(() => {
          if (owner.exitCode === null) owner.kill('SIGKILL')
        })
        let output = ''
        const ready = new Promise<void>((resolve, reject) => {
          owner.once('error', reject)
          owner.stdout.on('data', (chunk) => {
            output += chunk.toString()
            if (output.includes('owner ready')) resolve()
          })
        })
        const closed = new Promise<number | null>((resolve) =>
          owner.once('close', (code) => resolve(code)),
        )
        await ready
        if (shutdown === 'EOF') owner.stdin.end()
        else owner.kill(shutdown)
        assert.equal(await closed, 0)
        assert.equal(
          output.split('\n').filter((line) => line === 'owner cleanup').length,
          cleanup ? 1 : 0,
        )
        assert.match(
          output,
          shutdown === 'EOF'
            ? /stdin closed/
            : new RegExp(`Caught ${shutdown}`),
        )
      },
    )
  }
}
