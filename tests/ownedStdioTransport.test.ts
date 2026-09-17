import { test, mock, after } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'

let spawn: (...args: unknown[]) => unknown
mock.module('node:child_process', {
  namedExports: {
    spawn: (...args: unknown[]) => spawn(...args),
  },
})
after(() => mock.restoreAll())
const { OwnedStdioTransport } = await import(
  '../src/lib/ownedStdioTransport.js'
)

async function setup() {
  const writes: string[] = []
  let writeError: Error | undefined
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: new Writable({
      write(chunk, _encoding, callback) {
        writes.push(chunk.toString())
        callback(writeError)
      },
    }),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  const spawns: unknown[][] = []
  const owned: unknown[] = []
  let stops = 0
  const spawnOptions = { shell: true, detached: true }
  const owner = {
    spawnOptions,
    own(value: unknown) {
      owned.push(value)
      return async () => {
        stops++
      }
    },
  }
  const errors: unknown[][] = []
  spawn = (...args: unknown[]) => {
    spawns.push(args)
    return child
  }
  const transport = new OwnedStdioTransport('peer --stdio', owner as any, {
    info() {},
    error(...args: unknown[]) {
      errors.push(args)
    },
  })
  const messages: unknown[] = [],
    failures: Error[] = []
  let closes = 0
  transport.onmessage = (message) => messages.push(message)
  transport.onerror = (error) => failures.push(error)
  transport.onclose = () => {
    closes++
  }
  return {
    child,
    transport,
    writes,
    errors,
    messages,
    failures,
    spawns,
    owned,
    spawnOptions,
    stops: () => stops,
    closes: () => closes,
    failWrite: (error: Error) => {
      writeError = error
    },
  }
}

test('owned stdio transport preserves framing, UTF-8 and asynchronous writes', async (t) => {
  const b = await setup()
  await assert.rejects(
    b.transport.send({ jsonrpc: '2.0', id: 1, result: {} }),
    /closed/,
  )
  await b.transport.start()
  assert.deepEqual(b.spawns, [['peer --stdio', b.spawnOptions]])
  assert.deepEqual(b.owned, [b.child])
  const message = {
    jsonrpc: '2.0' as const,
    id: 0,
    result: { value: 'é世界🌍' },
  }
  const bytes = Buffer.from('\n \r\n' + JSON.stringify(message) + '\r\n')
  for (const byte of bytes) b.child.stdout.write(Buffer.from([byte]))
  assert.deepEqual(b.messages, [message])
  b.child.stdout.write('not-json\n{"no":"envelope"}\n')
  assert.deepEqual(b.errors, [
    ['Child non-JSON message:', 'not-json'],
    ['Child non-JSON message:', '{"no":"envelope"}'],
  ])
  b.child.stderr.write('diagnostic')
  assert.deepEqual(b.errors.at(-1), ['Child stderr:', 'diagnostic'])
  await b.transport.send(message)
  assert.deepEqual(b.writes, [JSON.stringify(message) + '\n'])
  b.transport.onmessage = undefined
  b.child.stdout.write(JSON.stringify(message) + '\n')
  assert.equal(b.messages.length, 1)
  await b.transport.close()
  await b.transport.close()
  assert.equal(b.closes(), 1)
  assert.equal(b.stops(), 2, 'the owner supplies its idempotent stop function')
  await assert.rejects(b.transport.send(message), /closed/)
})

for (const event of [
  'error',
  'stdin-error',
  'stdout-error',
  'stdout-end',
  'exit',
] as const) {
  test(`owned stdio ${event} reports failure and closes exactly once`, async (t) => {
    const b = await setup()
    await b.transport.start()
    const error = new Error('pipe failed')
    if (event === 'error') b.child.emit('error', error)
    if (event === 'stdin-error') b.child.stdin.emit('error', error)
    if (event === 'stdout-error') b.child.stdout.emit('error', error)
    if (event === 'stdout-end') b.child.stdout.emit('end')
    if (event === 'exit') b.child.emit('exit', 0, null)
    const expected =
      event === 'stdout-end'
        ? 'Child stdout closed'
        : event === 'exit'
          ? 'Child exited: code=0, signal=null'
          : 'pipe failed'
    assert.equal(b.failures.length, 1)
    assert.equal(b.failures[0].message, expected)
    assert.deepEqual(b.errors, [['MCP child failed:', b.failures[0]]])
    assert.equal(b.closes(), 1)
    assert.equal(b.stops(), 1)
    b.child.emit('error', new Error('late error'))
    assert.equal(b.failures.length, 1)
    assert.equal(b.stops(), 1)
  })
}

test('owned stdio write failure rejects the send and releases the child', async (t) => {
  const b = await setup()
  await b.transport.start()
  const error = new Error('write EPIPE')
  b.failWrite(error)
  await assert.rejects(
    b.transport.send({ jsonrpc: '2.0', id: 2, result: {} }),
    error,
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(b.failures, [error])
  assert.equal(b.stops(), 1)
})

test('owned stdio cleanup is safe without callbacks or a started child', async (t) => {
  const b = await setup()
  b.transport.onclose = undefined
  await b.transport.close()
  assert.equal(b.stops(), 0)
  const c = await setup()
  await c.transport.start()
  c.transport.onerror = undefined
  c.transport.onclose = undefined
  c.child.emit('error', new Error('unobserved failure'))
  assert.equal(c.stops(), 1)
  assert.equal(c.failures.length, 0)
})

for (const outcome of ['exit', 'failure', 'deadline'] as const) {
  test(`notification pipe drain handles ${outcome} and releases listeners`, async (t) => {
    const s = await setup()
    await s.transport.start()
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const before = s.child.listenerCount('exit')
    const pending = s.transport.finish()
    assert.equal(s.child.stdin.writableEnded, true)
    if (outcome === 'failure') {
      const rejected = assert.rejects(pending, /code=4/)
      s.child.emit('exit', 4, null)
      await rejected
    } else {
      if (outcome === 'exit') s.child.emit('exit', 0, null)
      else t.mock.timers.tick(5000)
      await pending
    }
    assert.equal(s.child.listenerCount('exit'), before)
    assert.deepEqual(s.failures, [])
    await s.transport.close()
    assert.equal(s.stops(), 1)
  })
}
test('notification drain tolerates absent, closed and already exited children', async () => {
  const s = await setup()
  await s.transport.finish()
  await s.transport.start()
  s.child.exitCode = 0
  await s.transport.finish()
  s.child.exitCode = null
  s.child.signalCode = 'SIGTERM'
  await s.transport.finish()
  s.child.signalCode = null
  await s.transport.close()
  await s.transport.finish()
  assert.equal(s.child.stdin.writableEnded, false)
})
