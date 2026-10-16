import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'

// How a config file's `command` + `args` start on Windows, where `npx` is a
// script only cmd.exe runs: cross-spawn decides, as it does for the MCP SDK's
// own client. It reads the platform once, when it loads, so here it is
// replaced by a record of what it was asked and a chosen answer; the real one
// is exercised on Windows by configFileE2e.

let answer: { command: string; args: string[]; options: object; file?: string }
const asked: unknown[][] = []
mock.module('cross-spawn', {
  defaultExport: {
    _parse: (...args: unknown[]) => {
      asked.push(args)
      return answer
    },
  },
})
after(() => mock.restoreAll())
const { spawnCommand } = await import('../src/lib/childCommand.js')

type Spawn = Parameters<typeof spawnCommand>[0]
const recordingSpawn = () => {
  const calls: unknown[][] = []
  const spawn = ((...args: unknown[]) => {
    calls.push(args)
    return { pid: 1 }
  }) as unknown as Spawn
  return { calls, spawn }
}
const onPlatform = (t: import('node:test').TestContext, value: string) => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value })
  t.after(() => Object.defineProperty(process, 'platform', platform))
}
const npx = { command: 'npx', args: ['-y', 'pkg', 'a b'] }

test('Windows: a script found on PATH runs as cross-spawn says, through cmd.exe', (t) => {
  onPlatform(t, 'win32')
  asked.length = 0
  answer = {
    command: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '"npx ^"-y^" ^"pkg^" ^"a^ b^""'],
    options: { shell: false, detached: false, windowsVerbatimArguments: true },
    file: 'C:\\Program Files\\nodejs\\npx.cmd',
  }
  const { calls, spawn } = recordingSpawn()
  spawnCommand(spawn, npx, { shell: true, detached: false })
  assert.deepEqual(asked, [
    ['npx', ['-y', 'pkg', 'a b'], { shell: false, detached: false }],
  ])
  assert.deepEqual(calls, [[answer.command, answer.args, answer.options]])
})

test('Windows: a command that is not found is started as given, and fails as before', (t) => {
  onPlatform(t, 'win32')
  answer = {
    command: 'C:\\Windows\\system32\\cmd.exe',
    args: ['/d', '/s', '/c', '"missing"'],
    options: { windowsVerbatimArguments: true },
  }
  const { calls, spawn } = recordingSpawn()
  spawnCommand(
    spawn,
    { command: 'missing', args: ['x'], cwd: 'C:\\srv' },
    { shell: true, detached: false },
  )
  assert.deepEqual(calls, [
    ['missing', ['x'], { shell: false, detached: false, cwd: 'C:\\srv' }],
  ])
})

test('elsewhere cross-spawn is not asked: the command starts as given', (t) => {
  onPlatform(t, 'linux')
  asked.length = 0
  const { calls, spawn } = recordingSpawn()
  spawnCommand(spawn, npx, { shell: true, detached: true })
  assert.deepEqual(asked, [])
  assert.deepEqual(calls, [
    ['npx', ['-y', 'pkg', 'a b'], { shell: false, detached: true }],
  ])
})
