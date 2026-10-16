import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { createSoakCommandGroup } from '../scripts/soak-command-group.mjs'

test(
  'a failed soak command stops concurrent load, preserves logs, and prevents later commands',
  {
    skip: process.platform === 'win32' && 'POSIX graceful signal cleanup',
    timeout: 15000,
  },
  async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'soak-fail-fast-'))
    t.after(() =>
      // Retried: on Windows a child just stopped may still be releasing a file
      // in it (ENOTEMPTY), as on main's run for 4.2.1-rc.1.
      rmSync(root, { recursive: true, force: true, maxRetries: 10 }),
    )
    const events: any[] = []
    const group = createSoakCommandGroup({
      root,
      events: (event: any) => events.push(event),
      env: { ...process.env, REPORT: root },
    })
    t.after(() => group.cancel('test cleanup'))
    const peer = group.run(
      'resource',
      [
        '-e',
        `const fs=require('node:fs');const p=require('node:path');process.on('SIGTERM',()=>{fs.writeFileSync(p.join(process.env.REPORT,'cleaned'),'yes');process.exit(0)});fs.writeFileSync(p.join(process.env.REPORT,'ready'),'yes');setInterval(()=>{},1000)`,
      ],
      60000,
    )
    const deadline = Date.now() + 5000
    while (!existsSync(join(root, 'ready'))) {
      assert.ok(Date.now() < deadline, 'peer did not start')
      await delay(10)
    }
    const failure = group.run(
      'battery',
      ['-e', `console.error('original failure');process.exit(7)`],
      5000,
    )
    const results = await Promise.allSettled([peer, failure])
    assert.equal(results[1].status, 'rejected')
    assert.equal(group.failed, true)
    assert.equal(readFileSync(join(root, 'cleaned'), 'utf8'), 'yes')
    assert.match(
      readFileSync(join(root, 'battery.log'), 'utf8'),
      /original failure/,
    )
    assert.ok(
      events.some(
        (row) =>
          row.phase === 'end-command' &&
          row.name === 'battery' &&
          row.code === 7,
      ),
    )
    await assert.rejects(
      group.run('must-not-start', ['-e', 'process.exit(0)'], 1000),
      /already cancelled/,
    )
    assert.equal(
      events.filter((row) => row.phase === 'start-command').length,
      2,
    )
  },
)

test('a timed-out soak command fails instead of allowing another cycle', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-timeout-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const events: any[] = []
  const group = createSoakCommandGroup({
    root,
    events: (event: any) => events.push(event),
    env: process.env,
  })
  t.after(() => group.cancel('test cleanup'))
  await assert.rejects(
    group.run('hung', ['-e', 'setInterval(()=>{},1000)'], 100),
    /hung failed/,
  )
  assert.equal(group.failed, true)
  assert.ok(events.some((row) => row.phase === 'end-command' && row.timedOut))
})

// A command that reports as it goes is judged by its silence. The first of
// these is the 4.2.0-rc.2 campaign's one failed lane in small: a group that
// took four times as long as usual, with every test passing as it went.
test('a command that keeps reporting may take longer than it may stay silent', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-slow-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const events: any[] = []
  const group = createSoakCommandGroup({
    root,
    events: (event: any) => events.push(event),
    env: process.env,
  })
  t.after(() => group.cancel('test cleanup'))
  // Eight reports 150 ms apart: 1.2 s in all, never 600 ms without one.
  await group.run(
    'slow',
    [
      '-e',
      `let n=0;const t=setInterval(()=>{console.log('test '+ ++n);if(n===8)clearInterval(t)},150)`,
    ],
    { quiet: 600, cap: 30000 },
  )
  assert.equal(group.failed, false)
  assert.deepEqual(
    events
      .filter((row) => row.phase === 'end-command')
      .map(({ code, timedOut, stalled }) => ({ code, timedOut, stalled })),
    [{ code: 0, timedOut: false, stalled: false }],
  )
  assert.equal(
    readFileSync(join(root, 'slow.log'), 'utf8').trim().split('\n').length,
    8,
  )
})

test('a command that goes silent is stopped as stuck, and the failure says so', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-stuck-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const events: any[] = []
  const group = createSoakCommandGroup({
    root,
    events: (event: any) => events.push(event),
    env: process.env,
  })
  t.after(() => group.cancel('test cleanup'))
  const started = Date.now()
  // It reports, on both streams, and then never again.
  await assert.rejects(
    group.run(
      'stuck',
      [
        '-e',
        `console.log('test 1');setTimeout(()=>console.error('warning'),300);setInterval(()=>{},1000)`,
      ],
      { quiet: 400, cap: 30000 },
    ),
    /stuck failed: nothing said for 0\.4s; inspect /,
  )
  assert.ok(Date.now() - started < 10000, 'long before its cap')
  // Silent for 400 ms after the warning at 300, not after the first line.
  assert.ok(Date.now() - started >= 650, 'what it says on stderr counts too')
  assert.equal(group.failed, true)
  assert.ok(
    events.some(
      (row) => row.phase === 'end-command' && row.timedOut && row.stalled,
    ),
  )
})

test('a command that never says anything is stuck from the start', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-mute-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const group = createSoakCommandGroup({ root, events() {}, env: process.env })
  t.after(() => group.cancel('test cleanup'))
  const started = Date.now()
  await assert.rejects(
    group.run('mute', ['-e', 'setInterval(()=>{},1000)'], {
      quiet: 300,
      cap: 30000,
    }),
    /mute failed: nothing said for 0\.3s; inspect /,
  )
  assert.ok(Date.now() - started < 10000, 'long before its cap')
})

test('a command that never stops reporting is stopped at its cap', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-endless-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const events: any[] = []
  const group = createSoakCommandGroup({
    root,
    events: (event: any) => events.push(event),
    env: process.env,
  })
  t.after(() => group.cancel('test cleanup'))
  await assert.rejects(
    group.run('endless', ['-e', `setInterval(()=>console.log('again'),50)`], {
      quiet: 5000,
      cap: 500,
    }),
    /endless failed: still running after 0\.5s; inspect /,
  )
  assert.ok(
    events.some(
      (row) =>
        row.phase === 'end-command' && row.timedOut && row.stalled === false,
    ),
  )
})

test('successful soak commands complete without cancelling the group', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-success-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const group = createSoakCommandGroup({ root, events() {}, env: process.env })
  await Promise.all([
    group.run('one', ['-e', 'console.log(42)'], 5000),
    group.run('two', ['-e', 'process.exit(0)'], 5000),
  ])
  assert.equal(group.failed, false)
  assert.equal(readFileSync(join(root, 'one.log'), 'utf8').trim(), '42')
})

// GitHub cancels the rest of a fail-fast matrix by signalling the whole tree.
// Every command still running then dies non-zero through our own `stop()`, and
// calling that a failure is what made eleven cancelled jobs in soak run
// 35270724649 indistinguishable from the one that genuinely failed.
test('a runner-cancelled command is reported as cancelled, not as a failure', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-cancelled-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const events: any[] = []
  const group = createSoakCommandGroup({
    root,
    events: (event: any) => events.push(event),
    env: { ...process.env, REPORT: root },
  })
  t.after(() => group.cancel('test cleanup'))
  const running = group.run(
    'cycle-6-group-0',
    [
      '-e',
      `require('node:fs').writeFileSync(require('node:path').join(process.env.REPORT,'ready'),'yes');setInterval(()=>{},1000)`,
    ],
    60000,
  )
  // Cancel a command that is genuinely mid-flight, which is the shape the
  // runner produces: not one killed before it could exec.
  const deadline = Date.now() + 5000
  while (!existsSync(join(root, 'ready'))) {
    assert.ok(Date.now() < deadline, 'command did not start')
    await delay(10)
  }
  group.cancel('SIGINT', true)
  await assert.rejects(
    running,
    /cycle-6-group-0 was cancelled before it finished \(SIGINT\)/,
  )
  const ended = events.find((row) => row.phase === 'end-command')
  assert.equal(ended.cancelled, true)
  assert.equal(ended.timedOut, false)
  assert.equal(group.cancelledExternally, true)
  const cancelling = events.find((row) => row.phase === 'cancel-commands')
  assert.deepEqual(
    { reason: cancelling.reason, external: cancelling.external },
    { reason: 'SIGINT', external: true },
  )
})

test('a genuine failure is never reported as an external cancellation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-genuine-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const events: any[] = []
  const group = createSoakCommandGroup({
    root,
    events: (event: any) => events.push(event),
    env: process.env,
  })
  t.after(() => group.cancel('test cleanup'))
  await assert.rejects(
    group.run('battery', ['-e', 'process.exit(7)'], 5000),
    /battery failed/,
  )
  assert.equal(group.failed, true)
  // The lane must still exit non-zero and still name the real culprit.
  assert.equal(group.cancelledExternally, false)
  const ended = events.find((row) => row.phase === 'end-command')
  assert.equal(ended.cancelled, false)
  assert.equal(ended.code, 7)
})

test('with keepGoing a failed soak command is recorded and everything else runs on', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-keep-going-'))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10 }))
  const events: any[] = []
  const group = createSoakCommandGroup({
    root,
    events: (event: any) => events.push(event),
    env: process.env,
    keepGoing: true,
  })
  t.after(() => group.cancel('test cleanup'))
  // Concurrent load that must not be cancelled by another command failing.
  const load = group.run('load', ['-e', 'setTimeout(() => {}, 1500)'], 10000)
  await assert.rejects(
    group.run('flaky', ['-e', 'process.exit(3)'], 5000),
    /flaky failed/,
  )
  assert.equal(group.failed, true)
  assert.equal(group.stopped, false)
  // A later command still starts and can pass.
  await group.run('next', ['-e', 'process.exit(0)'], 5000)
  await load
  assert.deepEqual(group.failures, ['flaky'])
  assert.ok(!events.some((row) => row.phase === 'cancel-commands'))
  assert.equal(
    events.filter((row) => row.phase === 'end-command' && row.code === 0)
      .length,
    2,
    'the load and the next command both finished',
  )
})
