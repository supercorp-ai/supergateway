import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { getLogger } from '../src/lib/getLogger.js'
import { jsonLine } from '../src/lib/jsonLogger.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  rpc,
  stdioRpc,
  unusedPort,
} from './helpers/gateway-process.js'

const at = new Date('2026-10-02T12:34:56.789Z')
const line = (level: 'info' | 'error', ...args: unknown[]) =>
  JSON.parse(jsonLine(level, args, at))

// Every line a stream carries, parsed, after checking it is one log entry.
const logLines = (text: string) =>
  text
    .split('\n')
    .slice(0, -1)
    .map((raw) => {
      const entry = JSON.parse(raw)
      assert.equal(typeof entry.time, 'string', raw)
      assert.equal(new Date(entry.time).toISOString(), entry.time, raw)
      assert.ok(['info', 'error'].includes(entry.level), raw)
      assert.equal(typeof entry.msg, 'string', raw)
      return entry as { time: string; level: string; msg: string }
    })

const messages = (text: string) => logLines(text).map((entry) => entry.msg)

test('a message alone is time, level and msg, and the level is the method called', () => {
  assert.deepEqual(line('info', 'Starting...'), {
    time: '2026-10-02T12:34:56.789Z',
    level: 'info',
    msg: 'Starting...',
  })
  assert.equal(line('error', 'boom').level, 'error')
  // No `data` key at all, rather than `data: undefined` or `[]`.
  assert.equal(jsonLine('info', ['a'], at).includes('data'), false)
  // With no clock passed, the line is stamped now.
  const before = Date.now()
  const stamped = Date.parse(JSON.parse(jsonLine('info', ['now'])).time)
  assert.ok(stamped >= before && stamped <= Date.now())
})

test('string arguments join into msg; one value is data as-is, several are an array', () => {
  const message = { jsonrpc: '2.0', id: 1, result: { tools: [] } }
  assert.deepEqual(line('info', 'Stdio → SSE:', message), {
    time: at.toISOString(),
    level: 'info',
    msg: 'Stdio → SSE:',
    data: message,
  })
  assert.deepEqual(line('info', 'Response finished', 'session-1', 7), {
    time: at.toISOString(),
    level: 'info',
    msg: 'Response finished session-1',
    data: 7,
  })
  assert.deepEqual(line('info', 'a', 1, 'b', [2], null).data, [1, [2], null])
  assert.equal(line('info', 'a', 1, 'b', [2]).msg, 'a b')
  // A value with no string at all still makes an entry.
  assert.deepEqual(line('error', { only: true }), {
    time: at.toISOString(),
    level: 'error',
    msg: '',
    data: { only: true },
  })
})

test('an Error is name, message, stack and code, wherever it sits', () => {
  const plain = new TypeError('bad input')
  assert.deepEqual(line('error', 'Request error:', plain).data, {
    name: 'TypeError',
    message: 'bad input',
    stack: plain.stack,
  })
  const coded = Object.assign(new Error('socket hang up'), {
    code: 'ECONNRESET',
  })
  assert.deepEqual(line('error', 'x', coded).data, {
    name: 'Error',
    message: 'socket hang up',
    stack: coded.stack,
    code: 'ECONNRESET',
  })
  // JSON-RPC errors carry numeric codes.
  const rpcError = Object.assign(new Error('Request timed out'), {
    code: -32001,
  })
  assert.equal(line('error', 'x', rpcError).data.code, -32001)
  // Nested in an object and in an argument list.
  assert.deepEqual(line('error', 'x', { failure: plain }).data, {
    failure: { name: 'TypeError', message: 'bad input', stack: plain.stack },
  })
  assert.deepEqual(
    line('error', 'x', 1, [plain]).data[1][0].message,
    'bad input',
  )
})

test('circular values, BigInt and throwing getters never throw', () => {
  const loop: Record<string, unknown> = { name: 'loop' }
  loop.self = loop
  loop.list = [loop]
  assert.deepEqual(line('info', 'x', loop).data, {
    name: 'loop',
    self: '[Circular]',
    list: ['[Circular]'],
  })
  // The same object twice, side by side, is not a cycle.
  const shared = { id: 1 }
  assert.deepEqual(line('info', 'x', { a: shared, b: shared }).data, {
    a: { id: 1 },
    b: { id: 1 },
  })
  assert.deepEqual(line('info', 'x', { big: 10n ** 20n }).data, {
    big: '100000000000000000000',
  })
  assert.equal(line('info', 'x', 5n).data, '5')
  const hostile = {
    get value() {
      throw new Error('getter failed')
    },
  }
  assert.deepEqual(line('error', 'Failed:', hostile), {
    time: at.toISOString(),
    level: 'error',
    msg: 'Failed:',
    data: '[Unserializable]',
  })
})

test('toJSON is honoured, as JSON.stringify would', () => {
  assert.deepEqual(line('info', 'x', { at }).data, { at: at.toISOString() })
  assert.equal(
    line('info', 'x', new URL('http://a.example/b')).data,
    'http://a.example/b',
  )
})

test('a multi-line message stays on one line', () => {
  const text = jsonLine('error', ['Child stderr: one\ntwo\r\nthree\n'], at)
  assert.equal(text.includes('\n'), false)
  assert.equal(text.includes('\r'), false)
  assert.equal(JSON.parse(text).msg, 'Child stderr: one\ntwo\r\nthree\n')
})

// The console as the logger sees it, with the clock held still.
const capture = (t: TestContext) => {
  t.mock.timers.enable({ apis: ['Date'], now: at.getTime() })
  const stdout: unknown[][] = []
  const stderr: unknown[][] = []
  t.mock.method(console, 'log', (...args: unknown[]) => stdout.push(args))
  t.mock.method(console, 'error', (...args: unknown[]) => stderr.push(args))
  return { stdout, stderr }
}

for (const outputTransport of ['stdio', 'sse', 'ws', 'streamableHttp']) {
  test(`json logger uses the text logger's streams for ${outputTransport} output`, (t) => {
    const { stdout, stderr } = capture(t)
    const logger = getLogger({
      logLevel: 'info',
      outputTransport,
      logFormat: 'json',
    })
    logger.info('value', { answer: 42 })
    logger.error('failure', 7)
    const info = jsonLine('info', ['value', { answer: 42 }], at)
    const error = jsonLine('error', ['failure', 7], at)
    // One argument per call: the line itself, with no prefix and nothing
    // for console to format.
    assert.deepEqual(
      { stdout, stderr },
      outputTransport === 'stdio'
        ? { stdout: [], stderr: [[info], [error]] }
        : { stdout: [[info]], stderr: [[error]] },
    )
  })
}

test('json lines are the same at debug and info, with no colour even on a TTY', (t) => {
  const { stdout, stderr } = capture(t)
  const tty = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY')
  Object.defineProperty(process.stderr, 'isTTY', {
    value: true,
    configurable: true,
  })
  t.after(() => {
    if (tty) Object.defineProperty(process.stderr, 'isTTY', tty)
    else Reflect.deleteProperty(process.stderr, 'isTTY')
  })
  for (const logLevel of ['info', 'debug']) {
    const logger = getLogger({
      logLevel,
      outputTransport: 'sse',
      logFormat: 'json',
    })
    logger.info('value', { nested: { deeper: { deepest: { answer: 42 } } } })
    logger.error('failure', new Error('boom'))
  }
  assert.equal(stdout.length, 2)
  assert.deepEqual(stdout[0], stdout[1])
  assert.equal(stderr.length, 2)
  assert.deepEqual(stderr[0], stderr[1])
  assert.equal(String(stdout[0]).includes('\u001b'), false)
  assert.deepEqual(JSON.parse(String(stdout[0])).data, {
    nested: { deeper: { deepest: { answer: 42 } } },
  })
})

test('json at log level none prints nothing', (t) => {
  const { stdout, stderr } = capture(t)
  for (const outputTransport of ['stdio', 'sse']) {
    const logger = getLogger({
      logLevel: 'none',
      outputTransport,
      logFormat: 'json',
    })
    logger.info('value', { answer: 42 })
    logger.error('failure', 7)
  }
  assert.deepEqual({ stdout, stderr }, { stdout: [], stderr: [] })
})

test('text, named or by default, is the prefixed console call it always was', (t) => {
  const { stdout, stderr } = capture(t)
  const value = { answer: 42 }
  for (const logFormat of ['text', undefined]) {
    const logger = getLogger({
      logLevel: 'info',
      outputTransport: 'sse',
      logFormat,
    })
    logger.info('value', value)
    logger.error('failure', 7)
  }
  assert.deepEqual(stdout, [
    ['[supergateway]', 'value', value],
    ['[supergateway]', 'value', value],
  ])
  assert.deepEqual(stderr, [
    ['[supergateway]', 'failure', 7],
    ['[supergateway]', 'failure', 7],
  ])
})

const noisyPeer = 'node tests/helpers/noisy-mcp-server.js'

test(
  'stdio→SSE with --logFormat json writes only JSON lines, info on stdout and errors on stderr',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      noisyPeer,
      '--port',
      String(port),
      '--logFormat',
      'json',
    ])
    await gateway.ready()
    // Each SSE session starts its own child, whose stderr is the multi-line
    // output this format has to keep on one line.
    const stream = new AbortController()
    t.after(() => stream.abort())
    const response = await fetch(`http://127.0.0.1:${port}/sse`, {
      signal: stream.signal,
    })
    assert.equal(response.status, 200)
    await gateway.waitFor(
      () => /Child stderr/.test(gateway.errors()),
      'log the child stderr',
    )
    stream.abort()
    await gateway.waitFor(
      () => /Client disconnected|SSE connection closed/.test(gateway.output()),
      'log the disconnect',
    )

    const info = logLines(gateway.output())
    const errors = logLines(gateway.errors())
    assert.deepEqual([...new Set(info.map((entry) => entry.level))], ['info'])
    assert.deepEqual(
      [...new Set(errors.map((entry) => entry.level))],
      ['error'],
    )
    const startup = info.map((entry) => entry.msg)
    for (const expected of [
      'Starting...',
      '  - outputTransport: sse',
      `Listening on port ${port}`,
      `SSE endpoint: http://localhost:${port}/sse`,
    ])
      assert.ok(startup.includes(expected), `missing ${expected}`)
    assert.equal(
      startup.some((msg) => msg.includes('[supergateway]')),
      false,
    )
    assert.ok(
      errors.some((entry) =>
        /^Child stderr \(session [^)]+\): peer stderr diagnostic\n$/.test(
          entry.msg,
        ),
      ),
      gateway.errors(),
    )
  },
)

test(
  'stdio→Streamable HTTP with --logFormat json writes only JSON lines',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      noisyPeer,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(port),
      '--logFormat',
      'json',
    ])
    await gateway.ready()
    const { messages: replies } = await rpc(
      `http://127.0.0.1:${port}/mcp`,
      initialize(1),
    )
    assert.equal(replies[0].id, 1)
    await gateway.waitFor(
      () =>
        /Child stderr/.test(gateway.errors()) &&
        /Initialize response received/.test(gateway.output()),
      'log the request',
    )

    const info = logLines(gateway.output())
    const errors = logLines(gateway.errors())
    assert.deepEqual([...new Set(info.map((entry) => entry.level))], ['info'])
    assert.deepEqual(
      [...new Set(errors.map((entry) => entry.level))],
      ['error'],
    )
    const startup = info.map((entry) => entry.msg)
    for (const expected of [
      'Starting...',
      '  - outputTransport: streamableHttp',
      'Running stateless server',
      `Listening on port ${port}`,
      `StreamableHttp endpoint: http://localhost:${port}/mcp`,
    ])
      assert.ok(startup.includes(expected), `missing ${expected}`)
    assert.ok(
      errors.some(
        (entry) => entry.msg === 'Child stderr: peer stderr diagnostic\n',
      ),
      gateway.errors(),
    )
  },
)

// A stdio→Streamable HTTP gateway for a bridge to point at.
const upstreamFor = async (t: TestContext) => {
  const port = await unusedPort()
  const upstream = launchGateway(t, [
    '--stdio',
    peerCommand,
    '--outputTransport',
    'streamableHttp',
    '--port',
    String(port),
  ])
  await upstream.ready()
  return `http://127.0.0.1:${port}/mcp`
}

// stdout of a stdio bridge: every line a JSON-RPC message, nothing else.
const protocolOnly = (text: string) => {
  const lines = text.split('\n').slice(0, -1)
  assert.ok(lines.length > 0)
  for (const raw of lines) {
    const message = JSON.parse(raw)
    assert.equal(message.jsonrpc, '2.0', raw)
    assert.equal('msg' in message || 'level' in message, false, raw)
  }
}

test(
  'Streamable HTTP→stdio with --logFormat json keeps stdout for the protocol and logs JSON on stderr',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const url = await upstreamFor(t)
    const bridge = launchGateway(t, [
      '--streamableHttp',
      url,
      '--logFormat',
      'json',
    ])
    await bridge.ready()
    await stdioRpc(bridge, initialize(1))
    const listed = await stdioRpc(bridge, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    })
    assert.ok(Array.isArray(listed.result.tools))
    await bridge.waitFor(
      () => bridge.errors().split('Response:').length > 2,
      'log both replies',
    )

    protocolOnly(bridge.output())
    const logs = logLines(bridge.errors())
    const msgs = logs.map((entry) => entry.msg)
    for (const expected of [
      'Starting...',
      '  - outputTransport: stdio',
      'Stdio server listening',
    ])
      assert.ok(msgs.includes(expected), `missing ${expected}`)
    // A relayed message is data, not text inside msg.
    const relayed = logs.find(
      (entry) =>
        entry.msg === 'Response:' &&
        (entry as { data?: { id?: number } }).data?.id === 2,
    ) as { data: { jsonrpc: string; result: unknown } } | undefined
    assert.ok(relayed, bridge.errors())
    assert.deepEqual(relayed.data.result, listed.result)
  },
)

test(
  '--logFormat text and no flag give identical output',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const url = await upstreamFor(t)
    const run = async (flags: string[]) => {
      const bridge = launchGateway(t, ['--streamableHttp', url, ...flags])
      await bridge.ready()
      await stdioRpc(bridge, initialize(1))
      await bridge.waitFor(
        () => /Response:/.test(bridge.errors()),
        'log the reply',
      )
      // Let anything else already written arrive before comparing.
      await delay(200)
      await bridge.dispose()
      return { stdout: bridge.output(), stderr: bridge.errors() }
    }
    const byDefault = await run([])
    const named = await run(['--logFormat', 'text'])
    assert.ok(byDefault.stderr.startsWith('[supergateway] Starting...\n'))
    assert.match(byDefault.stderr, /\[supergateway\] Response: \{/)
    assert.deepEqual(named, byDefault)
  },
)

test(
  '--logLevel none --logFormat json prints nothing',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const url = await upstreamFor(t)
    const bridge = launchGateway(t, [
      '--streamableHttp',
      url,
      '--logLevel',
      'none',
      '--logFormat',
      'json',
    ])
    // No ready line to wait for: a reply is the proof it is running.
    await stdioRpc(bridge, initialize(1))
    await delay(200)
    assert.equal(bridge.errors(), '')
    protocolOnly(bridge.output())
  },
)

test(
  '--logFormat xml is rejected the way yargs rejects other bad choices',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const rejected = async (flag: string, value: string) => {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--port',
        String(port),
        flag,
        value,
      ])
      const exit = await Promise.race([
        gateway.exited,
        delay(10000, 'still running'),
      ])
      return { exit, stdout: gateway.output(), stderr: gateway.errors() }
    }
    const format = await rejected('--logFormat', 'xml')
    const level = await rejected('--logLevel', 'loud')
    assert.deepEqual(format.exit, { code: 1, signal: null }, format.stderr)
    assert.equal(format.stdout, '')
    assert.match(
      format.stderr,
      /\nInvalid values:\n {2}Argument: logFormat, Given: "xml", Choices: "text", "json"\n$/,
    )
    // Same exit, same usage text; only the offending argument differs.
    const usage = (stderr: string) => stderr.replace(/ {2}Argument: .*\n$/, '')
    assert.deepEqual(
      { ...format, stderr: usage(format.stderr) },
      { ...level, stderr: usage(level.stderr) },
    )
  },
)
