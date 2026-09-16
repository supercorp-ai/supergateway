import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stdoutLines } from '../src/lib/stdoutLines.js'

test('stdout line limit counts bytes before LF and preserves every chunk boundary', () => {
  const expected = ['ą€🙂', '', 'next\r', 'done']
  const wire = Buffer.from(expected.join('\n') + '\n')
  for (let cut = 0; cut <= wire.length; cut++) {
    const lines: string[] = []
    let failures = 0
    const read = stdoutLines(
      9,
      (line) => lines.push(line),
      () => failures++,
    )
    read(wire.subarray(0, cut))
    read(wire.subarray(cut))
    assert.deepEqual(lines, ['ą€🙂', '', 'next', 'done'], `cut ${cut}`)
    assert.equal(failures, 0)
  }
})

test('stdout reader rejects an over-limit line before decoding and stops accepting output', () => {
  for (const chunks of [
    ['1234567890\nvalid\n'],
    ['12345', '67890'],
    ['ą€🙂', 'x\n'],
    ['123456789\r', '\n'],
  ]) {
    const lines: string[] = []
    let failures = 0
    const read = stdoutLines(
      9,
      (line) => lines.push(line),
      () => failures++,
    )
    read(Buffer.from('ok\n'))
    for (const chunk of chunks) read(Buffer.from(chunk))
    read(Buffer.from('ignored\n'))
    assert.deepEqual(lines, ['ok'])
    assert.equal(failures, 1, 'report once, even if more output arrives')
  }
})

test('stdout reader preserves one-byte fragments across buffer growth', () => {
  const text = 'a'.repeat(16384) + '🙂'
  const bytes = Buffer.from(text)
  const lines: string[] = []
  const read = stdoutLines(
    bytes.length,
    (line) => lines.push(line),
    () => assert.fail('valid line rejected'),
  )
  for (const byte of bytes) read(Buffer.from([byte]))
  assert.deepEqual(lines, [], 'no message before its delimiter')
  read(Buffer.from('\n'))
  read(Buffer.from('next\n'))
  assert.deepEqual(lines, [text, 'next'])
})

test('stdout limit is opt-in and omitted limits accept larger lines', () => {
  const line = 'x'.repeat(16 * 1024 * 1024 + 1)
  const lines: string[] = []
  const read = stdoutLines(
    undefined,
    (value) => lines.push(value),
    () => assert.fail('unlimited reader rejected a line'),
  )
  read(Buffer.from(line.slice(0, 100)))
  read(Buffer.from(line.slice(100) + '\n'))
  assert.deepEqual(lines, [line])
})

test('configured stdout storage stays within its byte budget with bounded allocations', (t) => {
  const allocate = Buffer.allocUnsafe
  const sizes: number[] = []
  t.mock.method(Buffer, 'allocUnsafe', (size: number) => {
    sizes.push(size)
    return allocate(size)
  })
  const max = 16389
  const one = Buffer.from('x')
  const lines: string[] = []
  const read = stdoutLines(
    max,
    (line) => lines.push(line),
    () => assert.fail('within limit'),
  )
  for (let i = 0; i < max; i++) read(one)
  // Bound retained capacity and allocation churn, not a particular growth factor.
  assert.ok(
    sizes.length > 0 && sizes.length <= 8,
    'one-byte input needs at most eight storage allocations',
  )
  assert.ok(
    sizes.every((size) => size <= max),
    'no allocation exceeds the configured line budget',
  )
  read(Buffer.from('\n'))
  assert.deepEqual(lines, ['x'.repeat(max)])
})
