import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getLogger } from '../src/lib/getLogger.js'
import { serializeCorsOrigin } from '../src/lib/serializeCorsOrigin.js'
import { corsOrigin } from '../src/lib/corsOrigin.js'
import { headers } from '../src/lib/headers.js'

test('CORS configuration preserves literals, regexes, invalid patterns and numeric entries', () => {
  assert.equal(corsOrigin({ argv: { cors: undefined } }), false)
  assert.equal(corsOrigin({ argv: { cors: [] } }), '*')
  assert.equal(corsOrigin({ argv: { cors: ['https://a.example', '*'] } }), '*')
  const origins = corsOrigin({
    argv: { cors: ['https://a.example', '/trusted\\.example$/', '/[/', 42] },
  })
  assert.deepEqual(origins, [
    'https://a.example',
    /trusted\.example$/,
    '/[/',
    '42',
  ])
  assert.deepEqual(JSON.parse(serializeCorsOrigin({ corsOrigin: origins })), [
    'https://a.example',
    '/trusted\\.example$/',
    '/[/',
    '42',
  ])
  assert.equal(serializeCorsOrigin({ corsOrigin: false }), 'false')
  assert.equal(serializeCorsOrigin({ corsOrigin: '*' }), '"*"')
})

test('header parsing preserves colon values, rejects empty fields and applies bearer precedence', () => {
  const errors: string[] = []
  const logger = {
    info() {},
    error: (message: unknown) => errors.push(String(message)),
  }
  const parsed = headers({
    argv: {
      header: [
        ' X-Trace : left:right ',
        'Bad',
        'sk-live-token-alone',
        '  Name  value-after-it ',
        ': value',
        'Empty: ',
        ': Bearer secret-token',
        'X-Trace: final',
      ],
    } as any,
    logger,
  })
  assert.deepEqual(parsed, { 'X-Trace': 'final' })
  assert.deepEqual(errors, [
    'Invalid header format: (no colon), ignoring',
    'Invalid header format: (no colon), ignoring',
    'Invalid header format: Name, ignoring',
    'Invalid header format: (missing name), ignoring',
    'Invalid header format: Empty, ignoring',
    'Invalid header format: (missing name), ignoring',
  ])
  assert.equal(
    errors.some((message) => /secret-token|sk-live|value-after/.test(message)),
    false,
    'a rejected header never echoes its value',
  )
  assert.deepEqual(
    headers({
      argv: {
        header: ['Authorization: old', 'X-Trace: trace'],
        oauth2Bearer: 'new',
      },
      logger,
    }),
    {
      Authorization: 'Bearer new',
      'X-Trace': 'trace',
    },
  )
})

for (const outputTransport of ['stdio', 'sse']) {
  for (const logLevel of ['none', 'info', 'debug']) {
    test(`${logLevel} logger routes and formats messages for ${outputTransport}`, (t) => {
      const stdout: unknown[][] = [],
        stderr: unknown[][] = []
      t.mock.method(console, 'log', (...args: unknown[]) => stdout.push(args))
      t.mock.method(console, 'error', (...args: unknown[]) => stderr.push(args))
      const colors = Object.getOwnPropertyDescriptor(
        process.stderr,
        'hasColors',
      )
      Object.defineProperty(process.stderr, 'hasColors', {
        value: undefined,
        configurable: true,
      })
      t.after(() => {
        if (colors) Object.defineProperty(process.stderr, 'hasColors', colors)
        else Reflect.deleteProperty(process.stderr, 'hasColors')
      })
      const logger = getLogger({ logLevel, outputTransport })
      const value = { nested: { answer: 42 } }
      logger.info('value', value)
      logger.error('failure', 7)
      if (logLevel === 'none') {
        assert.deepEqual(stdout, [])
        assert.deepEqual(stderr, [])
      } else {
        const rendered =
          logLevel === 'debug'
            ? '{\n  nested: {\n    answer: 42\n  }\n}'
            : value
        assert.deepEqual(
          stdout,
          outputTransport === 'stdio'
            ? []
            : [['[supergateway]', 'value', rendered]],
        )
        assert.deepEqual(stderr, [
          ...(outputTransport === 'stdio'
            ? [['[supergateway]', 'value', rendered]]
            : []),
          ['[supergateway]', 'failure', 7],
        ])
      }
    })
  }
}

test('debug logging colours inspected objects only where the terminal allows colour', (t) => {
  const stderr: unknown[][] = []
  t.mock.method(console, 'error', (...args: unknown[]) => stderr.push(args))
  const colors = Object.getOwnPropertyDescriptor(process.stderr, 'hasColors')
  t.after(() => {
    if (colors) Object.defineProperty(process.stderr, 'hasColors', colors)
    else Reflect.deleteProperty(process.stderr, 'hasColors')
  })
  // A terminal's stderr has hasColors(): false under NO_COLOR, true unless
  // something turns colour off. A pipe or file has no hasColors at all.
  const render = (hasColors: (() => boolean) | undefined) => {
    Object.defineProperty(process.stderr, 'hasColors', {
      value: hasColors,
      configurable: true,
    })
    stderr.length = 0
    getLogger({ logLevel: 'debug', outputTransport: 'stdio' }).error('value', {
      nested: { answer: 42 },
    })
    return stderr.at(-1)?.at(-1) as string
  }
  const plain = '{\n  nested: {\n    answer: 42\n  }\n}'
  // map: debug-tty-colorization
  assert.equal(
    render(() => true),
    '{\n  nested: {\n    answer: \u001b[33m42\u001b[39m\n  }\n}',
    'a terminal that allows colour gets ANSI-coloured inspection output',
  )
  // map: debug-no-color
  assert.equal(
    render(() => false),
    plain,
    'NO_COLOR (or a terminal without colour) gets no escape sequences',
  )
  // map: debug-plain-without-tty
  assert.equal(
    render(undefined),
    plain,
    'a pipe or file gets the same structure with no escape sequences',
  )
})
