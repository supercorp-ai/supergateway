import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'

test('modern SDK adapter supplies native crypto when the runtime has no crypto global', async (t) => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor)
    else Reflect.deleteProperty(globalThis, 'crypto')
  })
  Reflect.deleteProperty(globalThis, 'crypto')
  await import('../src/lib/modernSdk.js')
  assert.equal(globalThis.crypto.randomUUID, crypto.randomUUID)
  assert.equal(globalThis.crypto.getRandomValues, crypto.getRandomValues)
  const id = globalThis.crypto.randomUUID()
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
})
