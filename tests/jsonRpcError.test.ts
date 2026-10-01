import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpError } from '@modelcontextprotocol/sdk/types.js'
import { errorResponse, resultResponse } from '../src/lib/bridgeResponses.js'

// GW-007. The bridges' error replies, through the helper both now share:
// any thrown value yields a well-formed JSON-RPC error, and nothing thrown is
// modified. These used to be specification TODOs, for want of a boundary that
// was not a private detail of each bridge.
const req = { jsonrpc: '2.0' as const, id: 7, method: 'tools/call' }
const error = (err: unknown) => errorResponse(req, err).error

test('a protocol error keeps its code and loses the SDK prefix', () => {
  assert.deepEqual(errorResponse(req, new McpError(-32602, 'Bad params')), {
    jsonrpc: '2.0',
    id: 7,
    error: { code: -32602, message: 'Bad params' },
  })
  // Both ends of the reserved range are protocol codes.
  assert.equal(error({ code: -32768, message: 'x' }).code, -32768)
  assert.equal(error({ code: -32000, message: 'x' }).code, -32000)
})

test('a code outside the protocol range becomes -32000 and is kept in the message', () => {
  // A transport error's code is an HTTP status (StreamableHTTPError, SDK 1.24+).
  assert.deepEqual(error({ code: 503, message: 'Service Unavailable' }), {
    code: -32000,
    message: 'HTTP 503: Service Unavailable',
  })
  assert.equal(error({ code: -32769, message: 'x' }).message, 'HTTP -32769: x')
  assert.equal(error({ code: -31999, message: 'x' }).message, 'HTTP -31999: x')
  assert.equal(error({ code: 0, message: 'x' }).message, 'HTTP 0: x')
  // Older SDKs put the status in the message already: not twice.
  assert.equal(
    error({ code: 404, message: 'Error POSTing to endpoint (HTTP 404): gone' })
      .message,
    'Error POSTing to endpoint (HTTP 404): gone',
  )
})

test('a malformed code is not a code', () => {
  for (const code of [1.5, Number.NaN, Infinity, '-32602', null, {}]) {
    assert.deepEqual(error({ code, message: 'x' }), {
      code: -32000,
      message: 'x',
    })
  }
})

test('the SDK prefix is removed only when it names the reply’s own code', () => {
  assert.equal(
    error({ code: -32603, message: 'MCP error -32603: boom' }).message,
    'boom',
  )
  assert.equal(
    error({ code: -32603, message: 'MCP error -32000: boom' }).message,
    'MCP error -32000: boom',
  )
  // An ordinary Error: no code, so -32000, whose prefix is removed.
  assert.deepEqual(error(new Error('MCP error -32000: Request timed out')), {
    code: -32000,
    message: 'Request timed out',
  })
})

test('anything without a usable message is an internal error', () => {
  for (const err of [
    null,
    undefined,
    'a string',
    42,
    {},
    { message: 404 },
    { message: { text: 'x' } },
    { message: undefined },
  ])
    assert.deepEqual(error(err), { code: -32000, message: 'Internal error' })
})

test('structured detail is kept, and only when there is some', () => {
  assert.deepEqual(
    error({ code: -32602, message: 'x', data: { field: 'a' } }),
    {
      code: -32602,
      message: 'x',
      data: { field: 'a' },
    },
  )
  assert.equal('data' in error({ code: -32602, message: 'x' }), false)
  assert.equal(
    'data' in error({ code: -32602, message: 'x', data: undefined }),
    false,
  )
  assert.deepEqual(error({ code: -32602, message: 'x', data: 0 }).data, 0)
})

test('nothing thrown is modified', () => {
  const thrown = Object.freeze({
    code: 503,
    message: 'MCP error -32000: x',
    data: Object.freeze({ a: 1 }),
  })
  errorResponse(req, thrown)
  assert.deepEqual(thrown, {
    code: 503,
    message: 'MCP error -32000: x',
    data: { a: 1 },
  })
})

test('a result is passed on as a result, even one with a field named error', () => {
  const result = { error: 'application data', content: [] }
  const reply = resultResponse(req, result)
  assert.deepEqual(reply, { jsonrpc: '2.0', id: 7, result })
  assert.notEqual(reply.result, result, 'a copy, not the upstream object')
})

// GW-036: the upstream server's own error keeps the server's code.
test("an upstream server's application error keeps its code, message and data", () => {
  assert.deepEqual(
    error(new McpError(42, 'quota exceeded', { retryAfter: 5 })),
    { code: 42, message: 'quota exceeded', data: { retryAfter: 5 } },
  )
  assert.equal(error(new McpError(-1, 'x')).code, -1)
  // Not one the server could have sent (JSON-RPC codes are integers).
  assert.deepEqual(error(new McpError(1.5, 'x')), {
    code: -32000,
    message: 'MCP error 1.5: x',
  })
  // The same code on anything else is still an HTTP status.
  assert.equal(error({ code: 42, message: 'x' }).message, 'HTTP 42: x')
})
