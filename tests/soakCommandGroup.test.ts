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
    t.after(() => rmSync(root, { recursive: true, force: true }))
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
  t.after(() => rmSync(root, { recursive: true, force: true }))
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

test('successful soak commands complete without cancelling the group', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'soak-success-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
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
  t.after(() => rmSync(root, { recursive: true, force: true }))
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
  t.after(() => rmSync(root, { recursive: true, force: true }))
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
