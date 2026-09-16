import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as v8 from 'node:v8'
import { stdoutLines } from '../src/lib/stdoutLines.js'

test(
  'stdout reader releases its allocation after a complete line or overflow while its callback stays alive',
  { skip: typeof v8.queryObjects !== 'function' },
  (t) => {
    // Mark real allocations without keeping references to them or spying on the
    // release itself. The subclass keeps Buffer's implementation unchanged.
    class PendingBuffer extends Buffer {}
    const allocate = Buffer.allocUnsafe
    let tracking = false
    const allocation = t.mock.method(Buffer, 'allocUnsafe', (size: number) => {
      const buffer = allocate(size)
      if (tracking) Object.setPrototypeOf(buffer, PendingBuffer.prototype)
      return buffer
    })
    let failures = 0
    const lines: string[] = []
    const read = stdoutLines(
      16,
      (line) => lines.push(line),
      () => failures++,
    )
    const feed = (text: string) => {
      const chunk = Buffer.from(text)
      tracking = true
      try {
        read(chunk)
      } finally {
        tracking = false
      }
    }
    const retained = () => {
      allocation.mock.resetCalls() // Mock call history must not retain returned buffers.
      return v8.queryObjects(PendingBuffer, { format: 'count' })
    }
    feed('held')
    assert.equal(
      retained(),
      1,
      'positive control: incomplete line retains storage',
    )
    feed('\n')
    assert.deepEqual(lines, ['held'])
    assert.equal(retained(), 0, 'complete line releases storage')
    feed('another')
    assert.equal(retained(), 1)
    feed('01234567890123456789')
    assert.equal(failures, 1)
    assert.equal(
      retained(),
      0,
      'overflow releases storage before child cleanup',
    )
    feed('ignored\n')
    assert.deepEqual(lines, ['held'])
    assert.equal(failures, 1)
  },
)
