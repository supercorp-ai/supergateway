import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  decodedHeader,
  validateModernHeaders,
  validateToolHeaders,
  findToolSchema,
  HeaderMismatch,
} from '../src/lib/modernHeaders.js'
const headers = (values: Record<string, string>) => (name: string) =>
  values[name]
test('modern header decoding preserves plain values and requires valid Base64 and UTF-8', () => {
  for (const [input, expected] of [
    [undefined, undefined],
    ['plain', 'plain'],
    ['=?base64?x', '=?base64?x'],
    ['=?base64?aMOp?=', 'hé'],
    ['=?base64?!?=', undefined],
    ['=?base64?/w==?=', undefined],
  ] as const)
    assert.equal(decodedHeader(input), expected)
})
test('standard headers check protocol, method and encoded names without requiring names on extensions or notifications', () => {
  for (const method of [
    'tools/call',
    'prompts/get',
    'resources/read',
    'custom/echo',
  ]) {
    const request = {
      jsonrpc: '2.0',
      id: 0,
      method,
      params: {
        name: 'hé',
        uri: 'hé',
        _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
      },
    } as any
    const good = {
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': method,
      'mcp-name': '=?base64?aMOp?=',
    }
    assert.doesNotThrow(() => validateModernHeaders(request, headers(good)))
    for (const key of [
      'mcp-protocol-version',
      'mcp-method',
      ...(method === 'custom/echo' ? [] : ['mcp-name']),
    ]) {
      assert.throws(
        () =>
          validateModernHeaders(request, headers({ ...good, [key]: 'wrong' })),
        (error) =>
          error instanceof HeaderMismatch &&
          error.code === -32020 &&
          error.header === key,
      )
    }
  }
  assert.doesNotThrow(() =>
    validateModernHeaders(
      { jsonrpc: '2.0', method: 'custom/notify' } as any,
      headers({}),
    ),
  )
  assert.doesNotThrow(() =>
    validateModernHeaders(
      { jsonrpc: '2.0', id: 1, result: {} } as any,
      headers({}),
    ),
  )
  assert.doesNotThrow(() =>
    validateModernHeaders(
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} } as any,
      headers({ 'mcp-method': 'tools/call' }),
    ),
  )
})
test('tool mirrors support nested fields, false, zero and encoded Unicode without resolving references', () => {
  const schema = {
    properties: {
      nested: {
        properties: {
          count: { type: 'integer', 'x-mcp-header': 'Count' },
          flag: { type: 'boolean', 'x-mcp-header': 'Flag' },
          text: { type: 'string', 'x-mcp-header': 'Text' },
        },
      },
      missing: { 'x-mcp-header': 'Missing' },
      null: { 'x-mcp-header': 'Null' },
      $ref: { $ref: 'https://example.invalid/schema' },
      constructor: { 'x-mcp-header': 'Constructor' },
    },
  }
  const args = { nested: { count: 0, flag: false, text: 'hé' }, null: null }
  const good = {
    'mcp-param-count': '0.0',
    'mcp-param-flag': 'false',
    'mcp-param-text': '=?base64?aMOp?=',
  }
  assert.doesNotThrow(() => validateToolHeaders(schema, args, headers(good)))
  for (const key of Object.keys(good))
    for (const value of ['bad', ''])
      assert.throws(
        () =>
          validateToolHeaders(schema, args, headers({ ...good, [key]: value })),
        HeaderMismatch,
      )
  assert.throws(
    () => validateToolHeaders(schema, args, headers({})),
    HeaderMismatch,
  )
  assert.throws(
    () =>
      validateToolHeaders(
        { properties: { count: { type: 'integer', 'x-mcp-header': 'Count' } } },
        { count: 2 },
        headers({ 'mcp-param-count': '3' }),
      ),
    HeaderMismatch,
  )
  for (const value of [null, undefined, [], 42, 'string'])
    assert.doesNotThrow(() => validateToolHeaders(value, value, headers({})))
})
test('schema lookup keeps pagination opaque and rejects broken listing without looping', async () => {
  const calls: unknown[] = []
  const schema = { type: 'object', $ref: 'opaque' }
  assert.equal(
    await findToolSchema('wanted', async (cursor) => {
      calls.push(cursor)
      return cursor
        ? { tools: [{ name: 'wanted', inputSchema: schema }] }
        : { tools: [null, {}], nextCursor: 'opaque/+=' }
    }),
    schema,
  )
  assert.deepEqual(calls, [undefined, 'opaque/+='])
  assert.equal(
    await findToolSchema('absent', async () => ({ tools: [] })),
    undefined,
  )
  await assert.rejects(
    findToolSchema('x', async () => ({})),
    /Invalid tools\/list/,
  )
  let count = 0
  await assert.rejects(
    findToolSchema('x', async () => {
      count++
      return { tools: [], nextCursor: 'same' }
    }),
    /Repeated/,
  )
  assert.equal(count, 2)
})

test('header validation leaves parameter shape errors to the protocol layer', () => {
  for (const method of ['tools/call', 'resources/read'])
    assert.doesNotThrow(() =>
      validateModernHeaders(
        { jsonrpc: '2.0', id: 1, method } as any,
        headers({ 'mcp-method': method }),
      ),
    )
  const schema = {
    properties: { value: { type: 'integer', 'x-mcp-header': 'Value' } },
  }
  assert.doesNotThrow(() =>
    validateToolHeaders(
      schema,
      { value: '2' },
      headers({ 'mcp-param-value': '2' }),
    ),
  )
  assert.throws(
    () =>
      validateToolHeaders(
        schema,
        { value: '2' },
        headers({ 'mcp-param-value': '3' }),
      ),
    HeaderMismatch,
  )
})
