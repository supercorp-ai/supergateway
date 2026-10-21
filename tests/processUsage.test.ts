import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'

// The resource soaks' sampler on Windows: PowerShell stalls are retried, as
// every process-table read is, and a second is believed. 4.2.1-rc.1's 25-hour
// soak lost a lane to a single stalled sample.
const answers: Array<string | Error> = []
const asked: string[][] = []
mock.module('node:child_process', {
  namedExports: {
    execFileSync: (command: string, args: string[]) => {
      asked.push([command, ...args])
      const answer = answers.shift()
      if (answer instanceof Error) throw answer
      return answer
    },
    // Not used here; the helper's reaper imports it.
    execFile: () => assert.fail('processUsage reads synchronously'),
  },
})
after(() => mock.restoreAll())
const { processUsage } = await import('./helpers/process-tree.js')

const stall = () =>
  Object.assign(new Error('spawnSync powershell.exe ETIMEDOUT'), {
    code: 'ETIMEDOUT',
  })
const onWindows = (t: import('node:test').TestContext) => {
  answers.length = 0
  asked.length = 0
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  t.after(() => Object.defineProperty(process, 'platform', platform))
}

test('Windows: a stalled sample is asked again, up to four times', (t) => {
  onWindows(t)
  answers.push(stall(), stall(), stall(), '7 2048000 234\r\n')
  assert.deepEqual(processUsage([7]), [{ rssKiB: 2000, descriptors: 234 }])
  assert.equal(asked.length, 4)
  assert.equal(asked[0][0], 'powershell.exe')
})

test('Windows: a fourth stall is believed', (t) => {
  onWindows(t)
  answers.push(stall(), stall(), stall(), stall())
  assert.throws(() => processUsage([7]), /ETIMEDOUT/)
  assert.equal(asked.length, 4)
})

test('Windows: any other failure is not retried', (t) => {
  onWindows(t)
  answers.push(new Error('Get-Process : Cannot find a process'))
  assert.throws(() => processUsage([7]), /Cannot find a process/)
  assert.equal(asked.length, 1)
})
