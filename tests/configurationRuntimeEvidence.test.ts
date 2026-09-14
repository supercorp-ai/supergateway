import { test } from 'node:test'
import assert from 'node:assert/strict'
import { enableFakeTimers } from './helpers/fake-timers.js'

// Load the public modules inside this test so module initialization and the
// observed calls have the same test attribution. Existing tests load them
// before node:test starts and still remain useful behavioral checks.
test('public configuration modules preserve formatting, parsed values and idle cleanup', async (t) => {
  const [
    { getLogger },
    { corsOrigin },
    { headers },
    { serializeCorsOrigin },
    { SessionAccessCounter },
  ] = await Promise.all([
    import('../src/lib/getLogger.js'),
    import('../src/lib/corsOrigin.js'),
    import('../src/lib/headers.js'),
    import('../src/lib/serializeCorsOrigin.js'),
    import('../src/lib/sessionAccessCounter.js'),
  ])
  const stdout: unknown[][] = [],
    stderr: unknown[][] = []
  t.mock.method(console, 'log', (...args: unknown[]) => stdout.push(args))
  t.mock.method(console, 'error', (...args: unknown[]) => stderr.push(args))
  const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
  Object.defineProperty(process.stderr, 'isTTY', {
    value: false,
    configurable: true,
  })
  t.after(() => {
    if (tty) Object.defineProperty(process.stderr, 'isTTY', tty)
    else Reflect.deleteProperty(process.stderr, 'isTTY')
  })
  const value = { nested: { answer: 42 } }
  for (const logLevel of ['info', 'debug']) {
    for (const outputTransport of ['sse', 'stdio']) {
      stdout.length = 0
      stderr.length = 0
      const logger = getLogger({ logLevel, outputTransport })
      logger.info('value', value)
      logger.error('failure', 7)
      const rendered =
        logLevel === 'debug' ? '{\n  nested: {\n    answer: 42\n  }\n}' : value
      // map: logger-output
      assert.deepEqual(
        { stdout, stderr },
        {
          stdout:
            outputTransport === 'sse'
              ? [['[supergateway]', 'value', rendered]]
              : [],
          stderr: [
            ...(outputTransport === 'stdio'
              ? [['[supergateway]', 'value', rendered]]
              : []),
            ['[supergateway]', 'failure', 7],
          ],
        },
      )
    }
  }
  // map: cors-output
  assert.equal(
    serializeCorsOrigin({
      corsOrigin: corsOrigin({
        argv: { cors: ['https://a.example', '/trusted$/'] },
      }),
    }),
    '["https://a.example","/trusted$/"]',
  )
  // map: header-output
  assert.deepEqual(
    headers({
      argv: {
        header: [' X-Audit : left:right ', 'Authorization: old'],
        oauth2Bearer: 'new',
      },
      logger: { info() {}, error() {} },
    }),
    { 'X-Audit': 'left:right', Authorization: 'Bearer new' },
  )
  enableFakeTimers(t)
  const cleaned: string[] = []
  const counter = new SessionAccessCounter(25, (id) => cleaned.push(id), {
    info() {},
    error() {},
  })
  counter.inc('public-session', 'request')
  counter.dec('public-session', 'finished')
  t.mock.timers.tick(24)
  // map: not-early
  assert.deepEqual(cleaned, [])
  t.mock.timers.tick(1)
  // map: idle-cleanup
  assert.deepEqual(cleaned, ['public-session'])
})
