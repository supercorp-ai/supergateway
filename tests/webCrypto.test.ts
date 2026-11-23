import { test } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { provideWebCrypto } from '../src/lib/webCrypto.js'

test('without a global crypto, as on Node 18, Node’s Web Crypto is provided', () => {
  const node18: { crypto?: unknown } = {}
  provideWebCrypto(node18)
  assert.equal(node18.crypto, webcrypto)
})

test('a global crypto that is already defined is left as it is', () => {
  const own = { getRandomValues() {} }
  const node20 = { crypto: own }
  provideWebCrypto(node20)
  assert.equal(node20.crypto, own)
})

test('on this Node, importing it leaves the real global crypto in place', () => {
  assert.equal(globalThis.crypto, webcrypto)
})
