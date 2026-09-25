import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { escapeSseJsonSeparators } from '../src/lib/escapeSseJsonSeparators.js'

async function capture(write: (res: ServerResponse) => void) {
  const server = createServer((_req, res) => {
    escapeSseJsonSeparators(res)
    write(res)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const result = await fetch(`http://127.0.0.1:${address.port}`)
    const bytes = Buffer.from(await result.arrayBuffer())
    return {
      body: bytes.toString('utf8'),
      bytes,
      length: result.headers.get('content-length'),
      statusText: result.statusText,
      contentType: result.headers.get('content-type'),
    }
  } finally {
    server.close()
    await once(server, 'close')
  }
}

async function response(
  contentType: string,
  chunks: Buffer[],
  endChunk?: Buffer,
) {
  const originalLength =
    chunks.reduce((sum, chunk) => sum + chunk.length, 0) +
    (endChunk?.length ?? 0)
  return capture((res) => {
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': originalLength,
    })
    for (const chunk of chunks) res.write(chunk)
    res.end(endChunk)
  })
}

test('SSE escaping works when each UTF-8 separator is split across writes', async () => {
  const original = '😀 before\u2028middle\u2029after literal\\u2028'
  const frame = Buffer.from(`data: ${JSON.stringify({ text: original })}\n\n`)
  const { body, length } = await response(
    'text/event-stream',
    Array.from(frame, (byte) => Buffer.from([byte])),
  )
  assert.equal(length, null, 'the longer escaped body needs chunked framing')
  assert.ok(body.includes('\\u2028'))
  assert.ok(body.includes('\\u2029'))
  assert.equal(body.includes('\u2028'), false)
  assert.equal(body.includes('\u2029'), false)
  assert.equal(JSON.parse(body.slice(6)).text, original)
  assert.ok(body.endsWith('\n\n'), 'the SSE frame is not delayed by buffering')
})

test('an incomplete separator at the final write is preserved byte-for-byte', async () => {
  const frame = Buffer.from('data: "x"\n\n')
  const original = Buffer.concat([frame, Buffer.from([0xe2, 0x80])])
  const { body } = await response(
    'text/event-stream',
    [original.subarray(0, -1)],
    original.subarray(-1),
  )
  assert.deepEqual(Buffer.from(body), Buffer.from(original.toString('utf8')))
})

test('non-SSE responses retain their bytes and Content-Length', async () => {
  const body = Buffer.from(JSON.stringify({ text: 'before\u2028after' }))
  const result = await response('application/json', [body])
  assert.equal(result.body, body.toString())
  assert.equal(result.length, String(body.length))
})

test('SSE escaping respects status-message headers and implicit header writes', async () => {
  const frame = 'data: {"text":"a\u2028b"}\n\n'
  let callbacks = 0
  const explicit = await capture((res) => {
    res.writeHead(200, 'fine', {
      'CONTENT-TYPE': 'TEXT/EVENT-STREAM',
      'CONTENT-LENGTH': Buffer.byteLength(frame),
    })
    res.write(frame, 'utf8', () => callbacks++)
    res.end(() => callbacks++)
  })
  assert.equal(explicit.length, null)
  assert.equal(explicit.body, frame.replace('\u2028', '\\u2028'))
  // The wrapper rewrites the headers it forwards, so the status message and the
  // headers passed to writeHead must still reach the client.
  assert.equal(explicit.statusText, 'fine')
  assert.equal(explicit.contentType, 'TEXT/EVENT-STREAM')

  const implicit = await capture((res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write(frame, () => callbacks++)
    res.end('', 'utf8', () => callbacks++)
  })
  assert.equal(implicit.body, explicit.body)
  assert.equal(callbacks, 4)
})

test('SSE end can activate escaping without an earlier write', async () => {
  const frame = 'data: {"text":"a\u2029b"}\n\n'
  const result = await capture((res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.end(frame, 'utf8')
  })
  assert.equal(result.body, frame.replace('\u2029', '\\u2029'))
  let callbackRan = false
  const withCallback = await capture((res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.end(frame, () => {
      callbackRan = true
    })
  })
  assert.equal(withCallback.body, result.body)
  assert.equal(callbackRan, true)
})

test('late SSE wrapping preserves bytes after headers are sent', async () => {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/event-stream')
    res.writeHead(200)
    escapeSseJsonSeparators(res)
    res.end('data: {"text":"a\u2028b"}\n\n')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const result = await fetch(`http://127.0.0.1:${address.port}`)
    assert.equal(await result.text(), 'data: {"text":"a\\u2028b"}\n\n')
  } finally {
    server.close()
    await once(server, 'close')
  }
})

test('invalid UTF-8 lookalikes are not mistaken for JSON separators', async () => {
  const bytes = Buffer.from([
    0xe2, 0x00, 0xe2, 0x80, 0x00, 0xe2, 0x80, 0xa7, 0xe2, 0x80, 0xa8,
  ])
  const result = await response('text/event-stream', [bytes])
  assert.deepEqual(
    result.bytes,
    Buffer.concat([bytes.subarray(0, -3), Buffer.from('\\u2028')]),
  )
  const incompleteLookalike = Buffer.from([0x41, 0xe2, 0x00])
  const unchanged = await response('text/event-stream', [incompleteLookalike])
  assert.deepEqual(unchanged.bytes, incompleteLookalike)
})

test('non-SSE status-message responses are passed through', async () => {
  const result = await capture((res) => {
    res.writeHead(200, 'fine', { 'content-type': 'text/plain' })
    res.end('hello')
  })
  assert.equal(result.body, 'hello')
})
