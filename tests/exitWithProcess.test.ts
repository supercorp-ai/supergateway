import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import {
  exitWithProcessOf,
  probeProcess,
  watchProcess,
} from '../src/lib/exitWithProcess.js'
import { parseCli } from '../src/cli.js'
import {
  gatewayTimeout,
  initialize,
  launchGateway,
  peerCommand,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'
import { enableFakeTimers } from './helpers/fake-timers.js'
import { alreadyGone, descendantsOf } from './helpers/process-tree.js'

// --exitWithProcess <pid>: a launcher that does not give the gateway a stdin
// pipe used to leave it orphaned when the launcher died (#155: 3.7 days).

const errno = (code: string) => Object.assign(new Error(code), { code })
const throwing = (code: string) => () => {
  throw errno(code)
}
const silent = () => ({ info() {}, error() {} })
const recording = () => {
  const errors: unknown[][] = []
  return {
    errors,
    logger: { info() {}, error: (...a: unknown[]) => errors.push(a) },
  }
}
const alive = () => true
// The largest PID process.kill accepts; no platform ever hands it out.
const neverRunning = 0x7fffffff

// ---------------------------------------------------------------- probe

test('probeProcess: no error is alive, ESRCH is gone, EPERM is alive', () => {
  assert.equal(probeProcess(42, alive), 'alive')
  assert.equal(probeProcess(42, throwing('ESRCH')), 'gone')
  assert.equal(probeProcess(42, throwing('EPERM')), 'alive')
  const other = probeProcess(42, throwing('EINVAL'))
  assert.equal(typeof other, 'object')
  assert.equal(
    (other as { unexpected: NodeJS.ErrnoException }).unexpected.code,
    'EINVAL',
  )
})

test('probeProcess asks with signal 0 and defaults to process.kill', () => {
  const calls: unknown[][] = []
  probeProcess(42, (...args) => calls.push(args))
  assert.deepEqual(calls, [[42, 0]])
  assert.equal(probeProcess(process.pid), 'alive')
  assert.equal(probeProcess(neverRunning), 'gone')
})

// ---------------------------------------------------------------- validation

test('validation: absent flag means no watching', () => {
  assert.deepEqual(exitWithProcessOf({}, { kill: throwing('ESRCH') }), {})
  // Through the real parser too: no key, so nothing changes.
  assert.equal('exitWithProcess' in parseCli(['--stdio', 'x']), false)
})

test('validation: camelCase and kebab spellings both parse', () => {
  assert.equal(
    parseCli(['--stdio', 'x', '--exitWithProcess', '123']).exitWithProcess,
    123,
  )
  assert.equal(
    parseCli(['--stdio', 'x', '--exit-with-process', '123']).exitWithProcess,
    123,
  )
})

for (const [label, value] of [
  [
    'NaN (abc)',
    parseCli(['--stdio', 'x', '--exitWithProcess', 'abc']).exitWithProcess,
  ],
  ['a fraction', 1.5],
  ['negative', -5],
  ['no value', parseCli(['--stdio', 'x', '--exitWithProcess']).exitWithProcess],
  [
    'repeated',
    parseCli([
      '--stdio',
      'x',
      '--exitWithProcess',
      '7',
      '--exitWithProcess',
      '8',
    ]).exitWithProcess,
  ],
  ['above the 32-bit range', 0x80000000],
] as const)
  test(`validation: ${label} is not a positive integer`, () => {
    const result = exitWithProcessOf(
      { exitWithProcess: value as number },
      { kill: alive, ownPid: 99 },
    )
    assert.ok('error' in result)
    assert.match(
      result.error,
      /^Error: --exitWithProcess must be a positive integer PID, received: /,
    )
  })

test('validation: the 32-bit boundary itself is accepted', () => {
  assert.deepEqual(
    exitWithProcessOf(
      { exitWithProcess: 0x7fffffff },
      { kill: alive, ownPid: 99 },
    ),
    { pid: 0x7fffffff },
  )
})

for (const pid of [0, 1])
  test(`validation: PID ${pid} is rejected`, () => {
    const result = exitWithProcessOf(
      { exitWithProcess: pid },
      { kill: alive, ownPid: 99 },
    )
    assert.ok('error' in result)
    assert.match(
      result.error,
      new RegExp(`^Error: --exitWithProcess: PID ${pid} cannot be watched`),
    )
  })

test('validation: PID 2 is the smallest accepted', () => {
  assert.deepEqual(
    exitWithProcessOf({ exitWithProcess: 2 }, { kill: alive, ownPid: 99 }),
    { pid: 2 },
  )
})

test("validation: the gateway's own PID is rejected", () => {
  const result = exitWithProcessOf(
    { exitWithProcess: 99 },
    { kill: alive, ownPid: 99 },
  )
  assert.deepEqual(result, {
    error:
      "Error: --exitWithProcess: 99 is supergateway's own PID; pass the launcher's PID",
  })
  // The default is the real own PID.
  assert.match(
    (exitWithProcessOf({ exitWithProcess: process.pid }) as { error: string })
      .error,
    /own PID/,
  )
})

test('validation: a process that is not running is rejected', () => {
  const result = exitWithProcessOf(
    { exitWithProcess: 4242 },
    { kill: throwing('ESRCH'), ownPid: 99 },
  )
  assert.ok('error' in result)
  assert.match(
    result.error,
    /^Error: --exitWithProcess: process 4242 is not running\. In a container, the host's PIDs are not visible/,
  )
  // The default kill is the real one.
  assert.match(
    (exitWithProcessOf({ exitWithProcess: neverRunning }) as { error: string })
      .error,
    /is not running/,
  )
})

for (const [label, kill] of [
  ['a live process', alive],
  ["another user's process (EPERM)", throwing('EPERM')],
  ['a process that cannot be probed (EIO)', throwing('EIO')],
] as const)
  test(`validation: ${label} is accepted`, () => {
    assert.deepEqual(
      exitWithProcessOf({ exitWithProcess: 4242 }, { kill, ownPid: 99 }),
      { pid: 4242 },
    )
  })

// ---------------------------------------------------------------- watching

const until = async (predicate: () => boolean) => {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'condition never held')
    await delay(2)
  }
}

test('watchProcess: ESRCH fires onExit once and stops polling', async () => {
  let calls = 0
  let exits = 0
  const timer = watchProcess(42, {
    logger: silent(),
    intervalMs: 1,
    kill: () => {
      if (++calls >= 3) throw errno('ESRCH')
    },
    onExit: () => exits++,
  })
  await until(() => exits > 0)
  const polled = calls
  await delay(30)
  assert.equal(exits, 1)
  assert.equal(calls, polled, 'no poll after the process was gone')
  assert.equal(polled, 3)
  clearInterval(timer)
})

test('watchProcess: EPERM never fires and is not logged', async () => {
  let calls = 0
  let exits = 0
  const { errors, logger } = recording()
  const timer = watchProcess(42, {
    logger,
    intervalMs: 1,
    kill: () => {
      calls++
      throw errno('EPERM')
    },
    onExit: () => exits++,
  })
  await until(() => calls >= 10)
  clearInterval(timer)
  assert.equal(exits, 0)
  assert.deepEqual(errors, [])
})

test('watchProcess: another error counts as alive and is logged once', async () => {
  let calls = 0
  let exits = 0
  const { errors, logger } = recording()
  const failure = errno('EIO')
  const timer = watchProcess(42, {
    logger,
    intervalMs: 1,
    kill: () => {
      calls++
      throw failure
    },
    onExit: () => exits++,
  })
  await until(() => calls >= 10)
  clearInterval(timer)
  assert.equal(exits, 0)
  assert.equal(errors.length, 1)
  assert.match(String(errors[0][0]), /Could not check process 42/)
  assert.equal(errors[0][1], failure)
})

test('watchProcess: still exits after an unexpected error', async () => {
  let calls = 0
  let exits = 0
  const timer = watchProcess(42, {
    logger: silent(),
    intervalMs: 1,
    kill: () => {
      throw errno(++calls === 1 ? 'EIO' : 'ESRCH')
    },
    onExit: () => exits++,
  })
  await until(() => exits > 0)
  clearInterval(timer)
  assert.equal(calls, 2)
})

test('watchProcess: the timer is unrefd', () => {
  const timer = watchProcess(42, {
    logger: silent(),
    kill: alive,
    onExit: () => {},
  })
  assert.equal(timer.hasRef(), false)
  clearInterval(timer)
})

test('watchProcess: polls every 1000 ms by default, with process.kill', (t) => {
  enableFakeTimers(t, ['setInterval'])
  const calls: unknown[][] = []
  let exits = 0
  // Replaced before the call, so the default picks up the recording stand-in.
  t.mock.method(process, 'kill', (...args: unknown[]) => {
    calls.push(args)
    throw errno('ESRCH')
  })
  const timer = watchProcess(neverRunning, {
    logger: silent(),
    onExit: () => exits++,
  })
  t.mock.timers.tick(999)
  assert.equal(calls.length, 0)
  t.mock.timers.tick(1)
  assert.deepEqual(calls, [[neverRunning, 0]])
  assert.equal(exits, 1)
  clearInterval(timer)
})

// ---------------------------------------------------------------- requestShutdown

const runRequester = async (mode: 'registered' | 'unregistered') => {
  const owner = spawn(
    process.execPath,
    ['tests/helpers/shutdown-requester.mjs', mode],
    { stdio: 'pipe' },
  )
  let output = ''
  owner.stdout.on('data', (chunk) => (output += chunk))
  owner.stderr.on('data', (chunk) => (output += chunk))
  const [code] = await once(owner, 'close')
  return { code, output }
}

test('requestShutdown runs the registered shutdown once, then exits 0', async () => {
  const { code, output } = await runRequester('registered')
  assert.equal(code, 0)
  assert.deepEqual(output.trim().split('\n'), [
    'Shutdown requested. Exiting...',
    'owner cleanup',
    'after request',
    'owner cleanup settled',
  ])
})

test('requestShutdown with nothing registered exits 0 at once', async () => {
  const { code, output } = await runRequester('unregistered')
  assert.equal(code, 0)
  assert.equal(output, '')
})

// ---------------------------------------------------------------- end to end

// A process the test owns and can kill: the "launcher".
const disposable = (t: TestContext) => {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], {
    stdio: 'ignore',
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill('SIGKILL')
  })
  return child
}
const kill = async (child: ChildProcess) => {
  const exited = once(child, 'exit')
  child.kill('SIGKILL')
  await exited
}

const exitedWithin = async (
  gateway: ReturnType<typeof launchGateway>,
  ms: number,
) =>
  Promise.race([
    gateway.exited,
    delay(ms, undefined, { ref: false }).then(() => {
      throw Error(
        `gateway still running ${ms}ms after its launcher died:\n${gateway.output()}\n${gateway.errors()}`,
      )
    }),
  ])

// A gateway that accepted the flag would run until teardown; fail fast instead.
const exitCodeOf = (exited: Promise<{ code: number | null }>) =>
  Promise.race([
    exited.then(({ code }) => code),
    delay(requestTimeout(10000), 'still running', { ref: false }),
  ])

const childrenOf = (gateway: ReturnType<typeof launchGateway>) => () =>
  descendantsOf(gateway.child.pid!, { since: gateway.spawnedAt }).length

const connect = async (t: TestContext, url: URL, sse: boolean) => {
  const client = new Client(
    { name: 'e2e', version: '1.0.0' },
    { capabilities: {} },
  )
  const transport = sse
    ? new SSEClientTransport(url)
    : new StreamableHTTPClientTransport(url)
  t.after(() => client.close().catch(() => {}))
  await client.connect(transport)
}

const exitMessage = (pid: number) =>
  new RegExp(`Process ${pid} exited\\. Exiting\\.\\.\\.`)

for (const mode of ['sse', 'stateful'] as const)
  test(
    `stdio→${mode === 'sse' ? 'SSE' : 'Streamable HTTP stateful'}: exits 0 and stops its MCP server when the watched process dies`,
    { timeout: gatewayTimeout(30000) },
    async (t) => {
      const launcher = disposable(t)
      const port = await unusedPort()
      // stdin is a pipe the test holds open and never ends, so the exit on
      // stdin close cannot be what stops it.
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--port',
        String(port),
        ...(mode === 'sse'
          ? []
          : ['--outputTransport', 'streamableHttp', '--stateful']),
        '--exitWithProcess',
        String(launcher.pid),
      ])
      await gateway.ready()
      await connect(
        t,
        new URL(`http://127.0.0.1:${port}/${mode === 'sse' ? 'sse' : 'mcp'}`),
        mode === 'sse',
      )
      const children = childrenOf(gateway)
      assert.ok(children() > 0, 'the session has an MCP server process')
      await kill(launcher)
      const exit = await exitedWithin(gateway, 5000)
      assert.deepEqual(exit, { code: 0, signal: null })
      assert.match(gateway.output(), exitMessage(launcher.pid!))
      assert.match(
        gateway.output(),
        new RegExp(`- exitWithProcess: ${launcher.pid}`),
      )
      assert.doesNotMatch(gateway.output(), /stdin closed|Caught SIG/)
      await gateway.waitFor(() => children() === 0, 'stop its MCP server')
    },
  )

test(
  'Streamable HTTP→stdio bridge: exits 0 and ends its upstream session when the watched process dies',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const launcher = disposable(t)
    const port = await unusedPort()
    const upstream = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--outputTransport',
      'streamableHttp',
      '--stateful',
      '--port',
      String(port),
    ])
    await upstream.ready()
    // The kebab spelling, which yargs derives from the camelCase option.
    const bridge = launchGateway(t, [
      '--streamableHttp',
      `http://127.0.0.1:${port}/mcp`,
      '--exit-with-process',
      String(launcher.pid),
    ])
    await bridge.ready()
    bridge.child.stdin.write(JSON.stringify(initialize(1)) + '\n')
    await bridge.waitFor(
      () => bridge.output().includes('"id":1'),
      'initialize upstream',
    )
    const children = childrenOf(upstream)
    assert.ok(children() > 0, 'the bridge’s session has a server process')
    await kill(launcher)
    const exit = await exitedWithin(bridge, 5000)
    assert.deepEqual(exit, { code: 0, signal: null })
    // A bridge logs to stderr: its stdout is the MCP stream.
    assert.match(bridge.errors(), exitMessage(launcher.pid!))
    assert.doesNotMatch(bridge.errors(), /stdin closed|Caught SIG/)
    await upstream.waitFor(() => children() === 0, 'end the bridge’s session')
  },
)

test(
  'without the flag, an unrelated process dying changes nothing',
  { timeout: gatewayTimeout(30000) },
  async (t) => {
    const unrelated = disposable(t)
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(await unusedPort()),
    ])
    await gateway.ready()
    assert.doesNotMatch(gateway.output(), /exitWithProcess/)
    await kill(unrelated)
    await delay(2500)
    assert.equal(gateway.child.exitCode, null, 'the gateway is still running')
    assert.doesNotMatch(gateway.output() + gateway.errors(), /exited\. Exiting/)
  },
)

const rootOwned = () => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return
  return execFileSync('ps', ['-eo', 'pid=,uid='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .find(([pid, uid]) => uid === 0 && pid > 1)?.[0]
}

test(
  'a process owned by another user (EPERM) counts as running',
  {
    timeout: gatewayTimeout(30000),
    skip:
      rootOwned() === undefined &&
      'needs a non-root test user and a root-owned process (POSIX only)',
  },
  async (t) => {
    const pid = rootOwned()!
    assert.throws(() => process.kill(pid, 0), { code: 'EPERM' })
    const gateway = launchGateway(t, [
      '--stdio',
      peerCommand,
      '--port',
      String(await unusedPort()),
      '--exitWithProcess',
      String(pid),
    ])
    await gateway.ready()
    await delay(2500)
    assert.equal(gateway.child.exitCode, null, 'the gateway is still running')
    assert.doesNotMatch(
      gateway.output() + gateway.errors(),
      /exited\. Exiting|Could not check/,
    )
  },
)

for (const [label, value, message] of [
  [
    'a nonexistent PID',
    String(neverRunning),
    `Error: --exitWithProcess: process ${neverRunning} is not running. In a container, the host's PIDs are not visible`,
  ],
  ['PID 0', '0', 'Error: --exitWithProcess: PID 0 cannot be watched'],
  ['PID 1', '1', 'Error: --exitWithProcess: PID 1 cannot be watched'],
  [
    'abc',
    'abc',
    'Error: --exitWithProcess must be a positive integer PID, received: NaN',
  ],
  [
    '1.5',
    '1.5',
    'Error: --exitWithProcess must be a positive integer PID, received: 1.5',
  ],
  [
    'a negative PID',
    '-5',
    'Error: --exitWithProcess must be a positive integer PID, received: -5',
  ],
] as const)
  test(
    `${label} is rejected at startup with exit 1`,
    { timeout: gatewayTimeout(15000) },
    async (t) => {
      const gateway = launchGateway(t, [
        '--stdio',
        peerCommand,
        '--port',
        String(await unusedPort()),
        '--exitWithProcess',
        value,
      ])
      assert.equal(await exitCodeOf(gateway.exited), 1)
      assert.ok(
        gateway.errors().includes(message),
        `expected ${JSON.stringify(message)} in:\n${gateway.errors()}`,
      )
      // Rejected before anything starts.
      assert.doesNotMatch(gateway.output(), /Starting\.\.\./)
    },
  )

test(
  "the gateway's own PID is rejected at startup with exit 1",
  {
    timeout: gatewayTimeout(15000),
    // `exec` keeps the shell's PID, so `$$` is the gateway's PID before it
    // exists. No equivalent on Windows; the branch is unit-tested above.
    skip: process.platform === 'win32' && 'needs a POSIX shell',
  },
  async (t) => {
    const gateway = spawn(
      '/bin/sh',
      [
        '-c',
        'exec "$@" --exitWithProcess "$$"',
        'sh',
        process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath,
        process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js',
        '--stdio',
        peerCommand,
        '--port',
        String(await unusedPort()),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'], detached: true },
    )
    const exited = new Promise<{ code: number | null }>((resolve) =>
      gateway.once('exit', (code) => resolve({ code })),
    )
    t.after(async () => {
      // Its own group, so a gateway that wrongly started is reaped with its
      // MCP server.
      try {
        process.kill(-gateway.pid!, 'SIGKILL')
      } catch (error) {
        if (!alreadyGone(error)) throw error
      }
      await exited
    })
    let errors = ''
    gateway.stderr.on('data', (chunk) => (errors += chunk))
    gateway.stdout.resume()
    assert.equal(await exitCodeOf(exited), 1)
    assert.match(
      errors,
      new RegExp(
        `Error: --exitWithProcess: ${gateway.pid} is supergateway's own PID`,
      ),
    )
  },
)
