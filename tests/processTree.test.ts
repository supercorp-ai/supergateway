import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
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
        const table = '0 0\r\n10 1\r\n11 10\r\n12 11\r\n13 10\r\n99 1'
        return platform === 'win32'
          ? table
              .split('\r\n')
              .map((row) => row + ' 1000')
              .join('\r\n')
          : table
      },
    })
    assert.equal(queried, true)
    assert.deepEqual(result, [11, 12, 13])
    assert.deepEqual(
      descendantsOf(50, {
        platform,
        query: () =>
          platform === 'win32' ? '1 0 1000\n2 1 1001' : '1 0\n2 1\n',
      }),
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

// Windows keeps the creating PID after the creator exits. A later process may
// receive that PID, even while the older child (and its subtree) is still alive.
for (const nested of [false, true]) {
  test(`Windows PID reuse cannot attach an older ${nested ? 'grandchild' : 'child'} subtree`, () => {
    const rows = [
      [10, 1, '1000'],
      [11, 10, '1001'],
      [12, 11, '1002'],
      [13, 10, '1000'], // equal timestamps are allowed
      [20, nested ? 11 : 10, '900'], // impossible parent: born later than child
      ...Array.from({ length: 9 }, (_, i) => [21 + i, 20, String(901 + i)]),
    ]
    const found = descendantsOf(10, {
      platform: 'win32',
      query(_command, args) {
        // Both interfaces model the same process table. The old implementation
        // must fail the ancestry assertion, rather than merely reject new syntax.
        return rows
          .map((row) =>
            row.slice(0, args[4].includes('CreationDate') ? 3 : 2).join(' '),
          )
          .join('\n')
      },
    })
    assert.deepEqual(found, [11, 12, 13])
  })
}

test('Windows creation times preserve tick precision and reject unavailable ancestry evidence', () => {
  assert.deepEqual(
    descendantsOf(10, {
      platform: 'win32',
      query: () =>
        '10 1 639252000000000001\n11 10 639252000000000000\n12 10 639252000000000001',
    }),
    [12],
  )
  for (const table of ['10 1 0\n11 10 1000', '10 1 1000\n11 10 0']) {
    assert.throws(
      () => descendantsOf(10, { platform: 'win32', query: () => table }),
      /Process creation time unavailable/,
    )
  }
  // An exited ancestor can still have real living children on Windows.
  assert.deepEqual(
    descendantsOf(10, {
      platform: 'win32',
      query: () => '11 10 1000\n12 11 1001',
    }),
    [11, 12],
  )
})

test('captured Windows failure excludes system processes with reused parent PID 8128', () => {
  // Diagnostic run35265444224, Node24, round5. The old traversal counted10;
  // only three cmd.exe/node.exe pairs were created by gateway2320.
  const snapshot = JSON.parse(
    readFileSync(
      new URL('./helpers/windows-reused-parent.json', import.meta.url),
      'utf8',
    ),
  ) as { pid: number; parent: number; created: string; name: string }[]
  const found = descendantsOf(2320, {
    platform: 'win32',
    query(_command, args) {
      return snapshot
        .map((row) =>
          [
            row.pid,
            row.parent,
            ...(args[4].includes('CreationDate') ? [row.created] : []),
          ].join(' '),
        )
        .join('\n')
    },
  })
  assert.deepEqual(
    found.sort((a, b) => a - b),
    [564, 6436, 7004, 8128, 8480, 9116],
  )
})

test('parent cycles cannot hang process enumeration', () => {
  assert.deepEqual(
    descendantsOf(10, {
      platform: 'linux',
      query: () => '10 12\n11 10\n12 11\n12 11\n',
    }),
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
    // The exit event can precede IPC disconnect. Reuse one shutdown operation
    // so the after hook never sends again through a stale `connected` flag.
    let closing: Promise<unknown[]> | undefined
    const close = () =>
      (closing ??= (async () => {
        if (
          child.connected &&
          child.exitCode === null &&
          child.signalCode === null
        )
          await new Promise<void>((resolve, reject) => {
            child.send('stop', (error) => (error ? reject(error) : resolve()))
          })
        return await exited
      })())
    t.after(close)
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
    assert.deepEqual(await close(), [0, null])
    assert.deepEqual(query(), [])
  },
)

// Soak run 35305652456 lost a whole campaign in the canary preflight to
// "gateway ... (pid 736) has 128 live descendants", thrown after the test's own
// assertions had all passed — including that every continuation child was dead.
// The preflight shuts its gateway down before finishing, so the leak check ran
// against a root that had exited and was therefore absent from the table, which
// left its edges with nothing to be dated against. Windows keeps
// ParentProcessId after a parent dies and recycles low PIDs hard, so every
// stale claimant of 736 was counted, subtrees included.
test('an exited Windows root does not inherit the process tree of whoever held its PID', () => {
  const ticks = (ms: number) =>
    (BigInt(ms) * 10000n + 621355968000000000n).toString()
  const spawnedAt = 1_700_000_000_000
  const table = [
    `4 0 ${ticks(1)}`,
    // Claimants of pid 736 from long before this gateway existed, with a subtree.
    ...Array.from(
      { length: 128 },
      (_, i) => `${2000 + i} 736 ${ticks(spawnedAt - 600_000 + i)}`,
    ),
    ...Array.from(
      { length: 5 },
      (_, i) => `${5000 + i} 2000 ${ticks(spawnedAt - 500_000 + i)}`,
    ),
    // Children this gateway really did spawn, still alive after it exited.
    `3001 736 ${ticks(spawnedAt + 1000)}`,
    `3002 3001 ${ticks(spawnedAt + 2000)}`,
  ].join('\n')
  const query = () => table

  // Root 736 is absent: it has exited. Dated against our own spawn time, only
  // the two processes we actually started survive the walk.
  assert.deepEqual(
    descendantsOf(736, { platform: 'win32', query, since: spawnedAt }).sort(
      (a, b) => a - b,
    ),
    [3001, 3002],
  )
  // Without that evidence there is nothing to reject with, and the phantom
  // subtree comes back — which is what the soak reported.
  assert.ok(descendantsOf(736, { platform: 'win32', query }).length > 100)
})

test('a Windows root spawn time tolerates clock granularity rather than hiding children', () => {
  const ticks = (ms: number) =>
    (BigInt(ms) * 10000n + 621355968000000000n).toString()
  const spawnedAt = 1_700_000_000_000
  // A child the table dates a hair before our recorded spawn is still ours:
  // Date.now() and CIM CreationDate are different reads of the same clock.
  assert.deepEqual(
    descendantsOf(736, {
      platform: 'win32',
      query: () => `11 736 ${ticks(spawnedAt - 500)}`,
      since: spawnedAt,
    }),
    [11],
  )
  // Ten minutes earlier is not granularity, and must still be rejected.
  assert.deepEqual(
    descendantsOf(736, {
      platform: 'win32',
      query: () => `11 736 ${ticks(spawnedAt - 600_000)}`,
      since: spawnedAt,
    }),
    [],
  )
})
