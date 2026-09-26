import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LineSplitter } from '../src/lib/lineSplitter.js'

test('lines split at LF, drop a CR before it, and hold an unfinished tail', () => {
  const lines = new LineSplitter()
  assert.deepEqual(lines.push('{"a":1}\n{"b"'), ['{"a":1}'])
  assert.deepEqual(lines.push(':2}'), [], 'no newline yet: held')
  assert.deepEqual(lines.push('\r\n\n  \n'), ['{"b":2}', '', '  '])
  // A CRLF split between chunks is still one line ending.
  assert.deepEqual(lines.push('{"c":3}\r'), [])
  assert.deepEqual(lines.push('\n'), ['{"c":3}'])
  // A lone CR is data, and only one CR is dropped: this is what splitting on
  // /\r?\n/ did.
  assert.deepEqual(lines.push('x\ry\r\r\n'), ['x\ry\r'])
})

test('a line delivered in many chunks is joined once', () => {
  // Every reader used to rescan everything held on each chunk. Held text is
  // now only appended until a newline completes it.
  const lines = new LineSplitter()
  const piece = 'x'.repeat(64 * 1024)
  for (let i = 0; i < 64; i++) assert.deepEqual(lines.push(piece), [])
  const [line] = lines.push('\n')
  assert.equal(line.length, 64 * piece.length)
})
