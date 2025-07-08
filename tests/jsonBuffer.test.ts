import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  safeJsonStringify,
  safeJsonParse,
  JsonBuffer,
  sanitizeJsonObject,
} from '../src/lib/jsonBuffer.js'

test('safeJsonStringify should escape Unicode line separator U+2028', () => {
  const obj = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      message: 'Line with \u2028 separator',
    },
  }

  const result = safeJsonStringify(obj)
  assert.ok(result.includes('\\u2028'))
  assert.ok(!result.includes('\u2028'))

  // Verify it can be parsed back correctly
  const parsed = JSON.parse(result)
  assert.strictEqual(parsed.result.message, 'Line with \u2028 separator')
})

test('safeJsonStringify should escape Unicode paragraph separator U+2029', () => {
  const obj = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      message: 'Line with \u2029 separator',
    },
  }

  const result = safeJsonStringify(obj)
  assert.ok(result.includes('\\u2029'))
  assert.ok(!result.includes('\u2029'))

  // Verify it can be parsed back correctly
  const parsed = JSON.parse(result)
  assert.strictEqual(parsed.result.message, 'Line with \u2029 separator')
})

test('safeJsonStringify should handle regular JSON without issues', () => {
  const obj = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      message: 'Regular message',
    },
  }

  const result = safeJsonStringify(obj)
  const parsed = JSON.parse(result)
  assert.deepStrictEqual(parsed, obj)
})

test('safeJsonStringify should handle both separators in the same string', () => {
  const obj = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      message: 'Text with \u2028 line separator and \u2029 paragraph separator',
    },
  }

  const result = safeJsonStringify(obj)
  assert.ok(result.includes('\\u2028'))
  assert.ok(result.includes('\\u2029'))
  assert.ok(!result.includes('\u2028'))
  assert.ok(!result.includes('\u2029'))

  // Verify it can be parsed back correctly
  const parsed = JSON.parse(result)
  assert.strictEqual(
    parsed.result.message,
    'Text with \u2028 line separator and \u2029 paragraph separator',
  )
})

test('safeJsonParse should handle JSON with raw Unicode line separator U+2028', () => {
  // Create JSON string with raw Unicode line separator (as would come from problematic source)
  const problematicJson =
    '{"jsonrpc":"2.0","id":1,"result":{"message":"Line with \u2028 separator"}}'

  const parsed = safeJsonParse(problematicJson)
  assert.strictEqual(parsed.result.message, 'Line with \u2028 separator')
})

test('safeJsonParse should handle JSON with raw Unicode paragraph separator U+2029', () => {
  // Create JSON string with raw Unicode paragraph separator (as would come from problematic source)
  const problematicJson =
    '{"jsonrpc":"2.0","id":1,"result":{"message":"Line with \u2029 separator"}}'

  const parsed = safeJsonParse(problematicJson)
  assert.strictEqual(parsed.result.message, 'Line with \u2029 separator')
})

test('safeJsonParse should handle regular JSON without issues', () => {
  const regularJson =
    '{"jsonrpc":"2.0","id":1,"result":{"message":"Regular message"}}'

  const parsed = safeJsonParse(regularJson)
  assert.strictEqual(parsed.result.message, 'Regular message')
})

test('safeJsonParse should handle JSON with both raw Unicode separators', () => {
  // Create JSON string with both raw Unicode separators
  const problematicJson =
    '{"jsonrpc":"2.0","id":1,"result":{"message":"Text with \u2028 line separator and \u2029 paragraph separator"}}'

  const parsed = safeJsonParse(problematicJson)
  assert.strictEqual(
    parsed.result.message,
    'Text with \u2028 line separator and \u2029 paragraph separator',
  )
})

test('JsonBuffer should handle line-based JSON correctly', () => {
  const messages: any[] = []
  const errors: string[] = []

  const buffer = new JsonBuffer(
    (msg) => messages.push(msg),
    (error) => errors.push(error),
  )

  buffer.addChunk('{"jsonrpc":"2.0","id":1,"result":"test1"}\n')
  buffer.addChunk('{"jsonrpc":"2.0","id":2,"result":"test2"}\n')

  assert.strictEqual(messages.length, 2)
  assert.strictEqual(messages[0].result, 'test1')
  assert.strictEqual(messages[1].result, 'test2')
  assert.strictEqual(errors.length, 0)
})

test('JsonBuffer should handle large JSON without newlines', () => {
  const messages: any[] = []
  const errors: string[] = []

  const buffer = new JsonBuffer(
    (msg) => messages.push(msg),
    (error) => errors.push(error),
  )

  const largeContent = 'a'.repeat(2000) // Large content
  const jsonStr = `{"jsonrpc":"2.0","id":1,"result":{"content":"${largeContent}"}}`

  // Send in chunks without newlines
  const chunk1 = jsonStr.slice(0, 500)
  const chunk2 = jsonStr.slice(500, 1000)
  const chunk3 = jsonStr.slice(1000)

  buffer.addChunk(chunk1)
  assert.strictEqual(messages.length, 0) // Should not parse incomplete JSON

  buffer.addChunk(chunk2)
  assert.strictEqual(messages.length, 0) // Still incomplete

  buffer.addChunk(chunk3)
  assert.strictEqual(messages.length, 1) // Should parse complete JSON
  assert.strictEqual(messages[0].result.content, largeContent)
  assert.strictEqual(errors.length, 0)
})

test('JsonBuffer should ignore non-JSON output (like npm logs)', () => {
  const messages: any[] = []
  const errors: string[] = []

  const buffer = new JsonBuffer(
    (msg) => messages.push(msg),
    (error) => errors.push(error),
  )

  // Add non-JSON content that caused the original issue
  buffer.addChunk('added 41 packages, and audited 42 packages in 2s\n')
  buffer.addChunk('npm install output line\n')
  buffer.addChunk('more npm output\n')

  // Add a valid JSON message
  buffer.addChunk('{"jsonrpc":"2.0","id":1,"result":{"success":true}}\n')

  // Should have parsed only the JSON message, ignoring npm output
  assert.strictEqual(messages.length, 1)
  assert.strictEqual(messages[0].jsonrpc, '2.0')
  assert.strictEqual(messages[0].id, 1)

  // Should not have any errors since non-JSON content was silently ignored
  assert.strictEqual(errors.length, 0)
})

test('sanitizeJsonObject should escape Unicode characters for transport', () => {
  const input = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [
        {
          type: 'text',
          text: 'Trust Through Transparency. \u2028\u2028 Open Codebase.',
        },
      ],
    },
  }

  const sanitized = sanitizeJsonObject(input)

  // Should escape Unicode in nested objects
  assert.strictEqual(
    sanitized.result.content[0].text,
    'Trust Through Transparency. \\u2028\\u2028 Open Codebase.',
  )

  // Should be safe to stringify with standard JSON.stringify
  const stringified = JSON.stringify(sanitized)
  const parsed = JSON.parse(stringified)
  assert.strictEqual(
    parsed.result.content[0].text,
    'Trust Through Transparency. \\u2028\\u2028 Open Codebase.',
  )
})
