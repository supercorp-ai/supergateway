import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

test('version lookup reads package metadata and contains missing or malformed metadata', async (t) => {
  let contents: string | Error = '{"version":"7.2.1"}'
  const reads: unknown[][] = [],
    errors: unknown[][] = []
  t.mock.module('fs', {
    namedExports: {
      readFileSync(...args: unknown[]) {
        reads.push(args)
        if (contents instanceof Error) throw contents
        return contents
      },
    },
  })
  t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args))
  const { getVersion } = await import('../src/lib/getVersion.js')
  assert.equal(getVersion(), '7.2.1')
  assert.deepEqual(reads.pop(), [
    resolve(import.meta.dirname, '../package.json'),
    'utf-8',
  ])
  contents = '{}'
  assert.equal(getVersion(), '1.0.0')
  contents = '{invalid'
  assert.equal(getVersion(), 'unknown')
  assert.equal(errors.length, 1)
  assert.deepEqual(errors[0].slice(0, 2), [
    '[supergateway]',
    'Unable to retrieve version:',
  ])
  assert.ok(errors[0][2] instanceof SyntaxError)
  const unavailable = new Error('metadata unavailable')
  contents = unavailable
  assert.equal(getVersion(), 'unknown')
  assert.deepEqual(errors[1], [
    '[supergateway]',
    'Unable to retrieve version:',
    unavailable,
  ])
})
