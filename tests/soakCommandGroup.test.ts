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
