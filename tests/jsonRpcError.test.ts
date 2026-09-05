import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toJsonRpcError } from '../src/lib/toJsonRpcError.js'

test('error conversion handles thrown primitives and incomplete objects', () => {
  for (const error of [
    undefined,
    null,
    false,
    0,
    'failure',
    {},
    { code: 'wrong', message: 123 },
    { code: NaN },
    { code: Infinity },
    { code: 1.5 },
  ]) {
    assert.deepEqual(toJsonRpcError(error), {
      code: -32000,
      message: 'Internal error',
    })
  }
  assert.deepEqual(toJsonRpcError(new Error('network unavailable')), {
    code: -32000,
    message: 'network unavailable',
  })
  assert.deepEqual(toJsonRpcError({ code: -32601 }), {
    code: -32601,
    message: 'Internal error',
  })
  assert.deepEqual(
    toJsonRpcError({ code: 0, message: 'zero is a valid numeric code' }),
    { code: 0, message: 'zero is a valid numeric code' },
  )
})

test('error conversion strips only its matching protocol prefix', () => {
  const original = {
    code: -32601,
    message: 'MCP error -32601: Method not found ',
  }
  assert.deepEqual(toJsonRpcError(original), {
    code: -32601,
    message: 'Method not found',
  })
  assert.equal(original.message, 'MCP error -32601: Method not found ')
  assert.deepEqual(
    toJsonRpcError({
      code: -32000,
      message: 'MCP error -32601: keep this context',
    }),
    {
      code: -32000,
      message: 'MCP error -32601: keep this context',
    },
  )
})
