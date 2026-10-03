import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

// The bounded drain a modern notification's child gets (OwnedStdioTransport
// finish): its five-second deadline is a real timer, and a child that exits
// in time must not leave it armed behind it. A process the gateway no longer
// needs would otherwise stay referenced, and the event loop held, for the
// rest of the deadline after every notification.

let spawn: (...args: unknown[]) => unknown
mock.module('node:child_process', {
  namedExports: {
    spawn: (...args: unknown[]) => spawn(...args),
  },
})
after(() => mock.restoreAll())
const { OwnedStdioTransport } =
  await import('../src/lib/ownedStdioTransport.js')

// Timers the process is waiting on, as Node reports its active resources.
const armedTimers = () =>
  process.getActiveResourcesInfo().filter((name) => name === 'Timeout').length

for (const code of [0, 4]) {
  test(`notification drain disarms its deadline when the child exits with code ${code}`, async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      signalCode: null as string | null,
      stdin: new Writable({
        write(_chunk, _encoding, callback) {
          callback()
        },
      }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    })
    spawn = () => child
    const owner = {
      spawnOptions: {},
      own: () => async () => {},
    }
    const transport = new OwnedStdioTransport('peer --stdio', owner as any, {
      info() {},
      error() {},
    })
    await transport.start()
    const before = armedTimers()
    const drained = transport.finish()
    // map: deadline-armed
    assert.equal(armedTimers(), before + 1)
    child.emit('exit', code, null)
    if (code === 0) await drained
    else await assert.rejects(drained, /code=4/)
    // map: deadline-disarmed
    assert.equal(armedTimers(), before)
  })
}
