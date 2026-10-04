import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChildOwner } from '../src/lib/childHandoff.js'

// The stdio gateway for combined servers, with the servers replaced: what it
// does with everything a peer can report, alone on the process. End to end
// it is in combinedE2e.test.ts.
test('combined servers on stdio: what the servers report, and how the gateway ends', async (t) => {
  let owner!: ChildOwner
  const written: unknown[] = []
  const announced: unknown[] = []
  t.mock.module(new URL('../src/lib/serverSource.js', import.meta.url).href, {
    namedExports: {
      announceServer: (_logger: unknown, source: unknown) =>
        announced.push(source),
      startServer: () => (given: ChildOwner) => {
        owner = given
        return {
          write: (message: unknown) => {
            if (message === 5) throw TypeError('no message')
            written.push(message)
          },
          end() {},
          stop: async () => {},
          gone: false,
        }
      },
    },
  })
  const signals: { cleanup: () => Promise<void> }[] = []
  t.mock.module(new URL('../src/lib/onSignals.js', import.meta.url).href, {
    namedExports: {
      onSignals: (options: { cleanup: () => Promise<void> }) =>
        signals.push(options),
    },
  })
  const exits: unknown[] = []
  t.mock.method(process, 'exit', (code: unknown) => {
    exits.push(code)
  })
  const out: string[] = []
  t.mock.method(process.stdout, 'write', (chunk: unknown) => {
    out.push(String(chunk))
    return true
  })
  let onData!: (chunk: Buffer) => void
  t.mock.method(
    process.stdin,
    'on',
    (_event: string, listener: (chunk: Buffer) => void) => {
      onData = listener
      return process.stdin
    },
  )
  const info: unknown[][] = []
  const errors: unknown[][] = []
  const logger = {
    info: (...args: unknown[]) => info.push(args),
    error: (...args: unknown[]) => errors.push(args),
  }
  const { combinedToStdio } = await import('../src/gateways/combinedToStdio.js')
  const source = { combined: { name: 'all', members: [], warned: new Set() } }

  combinedToStdio({ ...source, logger } as never)
  assert.equal(announced.length, 1)
  assert.deepEqual(info, [['Stdio server listening']])
  // Alone, it takes the signals itself.
  assert.equal(signals.length, 1)

  // Lines in, whole and split across chunks; blank ones skipped.
  onData(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n\n{"jsonrpc"'))
  onData(Buffer.from(':"2.0","method":"x"}\nnot json\n5\n'))
  assert.deepEqual(written, [
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'x' },
  ])
  assert.deepEqual(errors, [
    ['Invalid message on stdin: not json'],
    ['Invalid message on stdin: 5'],
  ])

  // Messages out as their own lines; nothing to wait for on a stdout that
  // keeps up.
  owner.message({ any: 'thing' }, '{"as":"written"}')
  assert.deepEqual(out, ['{"as":"written"}\n'])
  assert.equal(owner.output(), undefined)

  errors.length = 0
  owner.nonJson('starting up')
  owner.stderr('a warning')
  assert.deepEqual(errors, [
    ['Server non-JSON: starting up'],
    ['Server stderr: a warning'],
  ])

  const failed = Error('spawn ENOENT')
  owner.failure('process', failed)
  assert.deepEqual(errors.at(-1), ['Server process failure:', failed])
  assert.deepEqual(exits, [1])
  owner.exit(2, null)
  assert.deepEqual(errors.at(-1), ['Servers stopped: code=2, signal=null'])
  assert.deepEqual(exits, [1, 1])

  // At shutdown the gateway stops the servers itself: their exit is no news.
  await signals[0].cleanup()
  const before = errors.length
  owner.exit(null, 'SIGTERM')
  assert.equal(errors.length, before)
  assert.deepEqual(exits, [1, 1])
})
