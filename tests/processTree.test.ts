import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { descendantsOf } from './helpers/process-tree.js'

for (const platform of ['win32', 'linux', 'darwin'] as const) {
  test(`${platform}: process enumeration counts descendants and excludes unrelated processes`, () => {
    let queried = false
    const result = descendantsOf(10, {
      platform,
      query(command, args, options) {
        queried = true
        assert.deepEqual(options, {
          encoding: 'utf8',
          timeout: platform === 'win32' ? 30000 : 10000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        if (platform === 'win32') {
          assert.equal(command, 'powershell.exe')
          assert.deepEqual(args.slice(0, 4), [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-Command',
          ])
          assert.match(args[4], /\$ErrorActionPreference = 'Stop'/)
          assert.match(
            args[4],
            /Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId/,
          )
        } else {
          assert.equal(command, 'ps')
          assert.deepEqual(args, ['-eo', 'pid=,ppid='])
        }
        return '0 0\r\n10 1\r\n11 10\r\n12 11\r\n13 10\r\n99 1\r\n'
      },
    })
    assert.equal(queried, true)
    assert.deepEqual(result, [11, 12, 13])
    assert.deepEqual(
      descendantsOf(50, { platform, query: () => '1 0\n2 1\n' }),
      [],
    )
  })

  test(`${platform}: a failed process query cannot pass as zero descendants`, () => {
    const failure = Object.assign(new Error('process enumeration timed out'), {
      code: 'ETIMEDOUT',
    })
    assert.throws(
      () =>
        descendantsOf(10, {
          platform,
          query: () => {
            throw failure
          },
        }),
      (error) => error === failure,
    )
    for (const table of [
      '',
      '  \r\n',
      'access denied',
      '12 nope',
      '12 10\ninvalid',
    ]) {
      assert.throws(
        () => descendantsOf(10, { platform, query: () => table }),
        /Process enumeration|Invalid process table/,
      )
    }
  })
}

test('parent cycles cannot hang process enumeration', () => {
  assert.deepEqual(
    descendantsOf(10, { query: () => '10 12\n11 10\n12 11\n12 11\n' }),
    [11, 12],
  )
})

test(
  'native process enumeration detects nine real descendants and their removal',
  // Two bounded Windows queries plus fixture startup and teardown.
  { timeout: process.platform === 'win32' ? 90000 : 30000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL('./helpers/process-tree-fixture.mjs', import.meta.url),
        ),
      ],
      { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    )
    const exited = once(child, 'exit')
    t.after(async () => {
      if (child.connected) child.send('stop')
      await exited
    })
    const [message] = (await once(child, 'message')) as [{ pids: number[] }]
    assert.equal(message.pids.length, 9)
    const query = () => {
      const started = performance.now()
      try {
        return descendantsOf(child.pid!)
      } finally {
        t.diagnostic(
          `Native process query took ${Math.round(performance.now() - started)}ms`,
        )
      }
    }
    const found = query()
    assert.ok(found.length > 8, 'the real fixture exceeds the leak budget')
    for (const pid of message.pids)
      assert.ok(found.includes(pid), `missing child ${pid}`)
    child.send('stop')
    assert.deepEqual(await exited, [0, null])
    assert.deepEqual(query(), [])
  },
)
