import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import {
  drained,
  holdOutput,
  readAsDrained,
} from '../src/lib/outputBackpressure.js'

// A response whose buffer is full until it is drained or destroyed.
const full = () => {
  const res = new Writable({
    highWaterMark: 1,
    write: (_chunk, _encoding, callback) => {
      res.once('flush', callback)
    },
  })
  res.write('x')
  assert.equal(res.writableNeedDrain, true)
  return res
}

const settled = async (promise: Promise<void>) =>
  Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ])

test('drained is undefined when no response is over its limit', () => {
  assert.equal(drained([]), undefined)
  assert.equal(drained([new PassThrough()]), undefined)
})

// drained relies on this: waiting on a response that has already closed would
// hold its child for good.
test('a full response stops needing to drain once destroyed', async () => {
  const res = full()
  res.destroy()
  assert.equal(res.writableNeedDrain, false)
  assert.equal(drained([res]), undefined)

  // And an HTTP response, which has its own writableNeedDrain.
  let checked = false
  const server = createServer((_req, response) => {
    while (response.write('x'.repeat(65536)));
    assert.equal(response.writableNeedDrain, true)
    response.destroy()
    assert.equal(response.writableNeedDrain, false)
    assert.equal(drained([response]), undefined)
    checked = true
    server.close()
  })
  const closed = new Promise((resolve) => server.once('close', resolve))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as { port: number }
  get(`http://127.0.0.1:${port}`, (res) => res.pause()).on('error', () => {})
  await closed
  assert.ok(checked)
})

test('drained settles once every full response drains or closes', async () => {
  const draining = full()
  const closing = full()
  const all = drained([draining, closing, new PassThrough()])!
  assert.equal(await settled(all), false)
  draining.emit('flush')
  assert.equal(await settled(all), false)
  closing.destroy()
  assert.equal(await settled(all), true)
  // Both listeners go once either fires, so a long-lived response that fills
  // and drains many times does not collect them.
  assert.equal(draining.listenerCount('drain'), 0)
  assert.equal(draining.listenerCount('close'), 0)
})

test('holdOutput pauses until drained, and only once while held', async () => {
  const stdout = new PassThrough()
  stdout.on('data', () => {})
  holdOutput(stdout, undefined)
  assert.equal(stdout.isPaused(), false)

  let release!: () => void
  holdOutput(stdout, new Promise<void>((resolve) => (release = resolve)))
  assert.equal(stdout.isPaused(), true)
  // Already held: a second hold must not resume it when it settles first.
  holdOutput(stdout, Promise.resolve())
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stdout.isPaused(), true)

  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stdout.isPaused(), false)
})

// A body of three chunks that records how many have been taken from it.
const upstream = () => {
  let pulled = 0
  let cancelled: unknown
  const chunks = ['a', 'b', 'c'].map((text) => new TextEncoder().encode(text))
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (pulled === chunks.length) controller.close()
        else controller.enqueue(chunks[pulled++])
      },
      cancel(reason) {
        cancelled = reason
      },
    },
    { highWaterMark: 0 },
  )
  return {
    response: new Response(body, {
      status: 201,
      statusText: 'Made',
      headers: { 'content-type': 'text/event-stream' },
    }),
    pulled: () => pulled,
    cancelled: () => cancelled,
  }
}

test('readAsDrained reads the body only while the output keeps up', async () => {
  const output = full()
  const source = upstream()
  const held = readAsDrained(source.response, output)
  assert.equal(held.status, 201)
  assert.equal(held.statusText, 'Made')
  assert.equal(held.headers.get('content-type'), 'text/event-stream')
  const reader = held.body!.getReader()
  const first = reader.read()
  assert.equal(await settled(first.then(() => {})), false, 'held while full')
  assert.equal(source.pulled(), 0, 'nothing taken from upstream meanwhile')
  output.emit('flush')
  assert.equal(
    new TextDecoder().decode((await first).value),
    'a',
    'read once drained',
  )
  const rest: string[] = []
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    rest.push(new TextDecoder().decode(value))
  }
  assert.deepEqual(rest, ['b', 'c'])
})

test('readAsDrained passes a cancel upstream and keeps url and redirected', async () => {
  const source = upstream()
  Object.defineProperties(source.response, {
    url: { value: 'https://upstream.example/sse' },
    redirected: { value: true },
  })
  const held = readAsDrained(source.response, new PassThrough())
  assert.equal(held.url, 'https://upstream.example/sse')
  assert.equal(held.redirected, true)
  await held.body!.cancel('client gone')
  assert.equal(source.cancelled(), 'client gone')
})

test('readAsDrained hands on a response without a body unchanged', () => {
  const empty = new Response(null, { status: 204 })
  assert.equal(readAsDrained(empty, new PassThrough()), empty)
})
