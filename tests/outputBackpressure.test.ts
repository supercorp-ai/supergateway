import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, get } from 'node:http'
import { PassThrough, Writable } from 'node:stream'
import { drained, holdOutput } from '../src/lib/outputBackpressure.js'

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
