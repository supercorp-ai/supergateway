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

for (const result of ['resolve', 'reject']) {
  test(
    `shutdown waits for asynchronous cleanup to ${result} and ignores repeated signals`,
    { timeout: 5000 },
    async (t) => {
      const owner = spawn(
        process.execPath,
        ['tests/helpers/signal-owner.mjs', result],
        { stdio: 'pipe' },
      )
      t.after(() => {
        if (owner.exitCode === null) owner.kill('SIGKILL')
      })
      let output = '',
        errors = ''
      owner.stderr.on('data', (chunk) => {
        errors += String(chunk)
      })
      owner.stdout.on('data', (chunk) => {
        output += String(chunk)
      })
      const wait = (marker: string) =>
        new Promise<void>((resolve) => {
          const observe = () => {
            if (output.includes(marker)) {
              owner.stdout.off('data', observe)
              resolve()
            }
          }
          owner.stdout.on('data', observe)
        })
      const closed = new Promise((resolve) => owner.once('close', resolve))
      await wait('owner ready')
      const cleaning = wait('owner cleanup')
      owner.kill('SIGTERM')
      await cleaning
      owner.kill('SIGINT')
      owner.kill('SIGHUP')
      assert.equal(owner.exitCode, null, 'cleanup has not settled yet')
      assert.equal(await closed, result === 'resolve' ? 0 : 1)
      assert.match(output, /owner cleanup settled/)
      assert.equal(
        output.split('\n').filter((line) => line === 'owner cleanup').length,
        1,
      )
      if (result === 'reject') assert.match(errors, /Shutdown cleanup failed/)
    },
  )
}
