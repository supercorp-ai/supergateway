import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anyResult } from '../src/lib/anyResult.js'

// What the SDK does with a request's result schema: `parse` before 1.2x,
// `safeParse` since. Either way the result comes back as the server sent it.
const schema = anyResult as unknown as {
  parse: (value: unknown) => unknown
  safeParse: (value: unknown) => { success: boolean; data: unknown }
}

test('anyResult hands back the result itself, through either SDK call', () => {
  const result = { content: [{ type: 'text', text: 'hi' }], extra: 1 }
  assert.equal(schema.parse(result), result)
  assert.deepEqual(schema.safeParse(result), { success: true, data: result })
  assert.equal(schema.safeParse(result).data, result)
})

test('anyResult is not a zod 4 schema, so every SDK takes the plain path', () => {
  assert.equal('_zod' in (anyResult as object), false)
})
