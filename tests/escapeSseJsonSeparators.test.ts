import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { escapeSseJsonSeparators } from '../src/lib/escapeSseJsonSeparators.js'

async function response(
  contentType: string,
  chunks: Buffer[],
  endChunk?: Buffer,
) {
  const originalLength =
    chunks.reduce((sum, chunk) => sum + chunk.length, 0) +
    (endChunk?.length ?? 0)
  const server = createServer((_req, res) => {
    escapeSseJsonSeparators(res)
    res.writeHead(200, {
      'content-type': contentType,
      'content-length': originalLength,
    })
    for (const chunk of chunks) res.write(chunk)
    res.end(endChunk)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const result = await fetch(`http://127.0.0.1:${address.port}`)
    return {
      body: await result.text(),
      length: result.headers.get('content-length'),
    }
  } finally {
    server.close()
    await once(server, 'close')
  }
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
