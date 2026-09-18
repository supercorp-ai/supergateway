import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { randomInt } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { watchGateway, forgetGateway } from './leak-check.js'

// Eight seconds is many times the healthy worst case: across a full soak the
// slowest relay-edge gateway reached its ready line in under four. The override
// exists so a loaded runner can be given headroom without editing this file —
// raising it hides nothing, because the failure message now reports how long
// the gateway actually took and whether it ever ran at all.
const readyTimeout = () => {
  // A workflow that sets this per-platform hands every other platform an empty
  // string, and `??` does not fall back on one — `Number('')` is 0, which would
  // silently give every gateway a zero-millisecond budget. Only a positive
  // number overrides the default.
  const configured = Number(process.env.SUPERGATEWAY_TEST_READY_TIMEOUT)
  return Number.isFinite(configured) && configured > 0 ? configured : 8000
}

// A test has to outlive its own readiness wait. node:test kills the test at its
// timeout and reports only that it timed out, so a per-test timeout below the
// readiness budget throws away the diagnosis the wait exists to produce — and
// the two are written in different files, so they invert silently. Deriving one
// from the other keeps a raised budget from blinding the tests it is meant to
// help.
// Capped so that one hung test cannot eat the twelve-minute budget the soak
// gives a whole group: past this point the group timeout is the better backstop.
const maxTestTimeout = 240000

export const gatewayTimeout = (ms: number) =>
  Math.max(
    Math.min(Math.round(ms * slowHostFactor()), maxTestTimeout),
    readyTimeout() + 7000,
  )

// How much slower this platform is assumed to be, taken from the one knob a
// workflow already sets. A runner that needs four times as long to get a
// gateway listening needs the same slack for the requests that follow it, and
// deriving both from one signal stops them drifting apart.
const slowHostFactor = () => readyTimeout() / 8000

// A client request budget inside a test. These are setup, not assertions: the
// tests carrying them check which protocol era is negotiated or what a response
// contains, never how fast the round trip was. Three campaigns have now been
// lost to one of them firing on a transient stall.
export const requestTimeout = (ms: number) => Math.round(ms * slowHostFactor())

// A stalled gateway that writes nothing cannot, by itself, tell a stuck gateway
// from a host that could not have started any process. Timing a bare Node start
// at the moment of failure can: it is tens of milliseconds on a healthy runner,
// so a second or more is the host, not the gateway. Kept short so it fits
// inside what the test has left.
const controlBudget = 2000

// Launch the actual compiled CLI. A separate process group also lets teardown
// reap the shell and stdio MCP child, even when an assertion fails.
export function launchGateway(
  t: TestContext,
  args: string[],
  env?: Record<string, string>,
  nodeArgs: string[] = [],
) {
  const grouped = process.platform !== 'win32'
  const child = spawn(
    process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath,
    [
      ...nodeArgs,
      process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js',
      ...args,
    ],
    {
      stdio: 'pipe',
      detached: grouped,
      env: env ? { ...process.env, ...env } : process.env,
    },
  )
  let output = ''
  let errors = ''
  // A readiness failure reports whatever was captured, and "nothing at all" is
  // a different diagnosis from "something, but not the ready line": the gateway
  // logs `Starting...` within milliseconds of the entry running, so empty
  // streams mean it never reached its own first line.
  const spawnedAt = Date.now()
  let firstByteAt: number | null = null
  const record = (chunk: string) => {
    firstByteAt ??= Date.now()
    return chunk
  }
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += record(chunk)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    errors += record(chunk)
  })
  let spawnError: Error | null = null
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once('error', (error) => {
        spawnError = error
        reject(error)
      })
      child.once('exit', (code, signal) => resolve({ code, signal }))
    },
  )
  // A spawn error rejects this long before any consumer awaits it, and an
  // unhandled rejection takes down the whole test file with a stack that names
  // node:internal rather than the gateway that failed. Record it instead and
  // let `waitFor` report it; teardown uses the non-rejecting alias.
  const settled = exited.then(
    (value) => value,
    () => ({ code: null, signal: null }),
  )
  const signal = (name: NodeJS.Signals) => {
    try {
      if (grouped && child.pid) process.kill(-child.pid, name)
      else child.kill(name)
    } catch (error) {
      // ESRCH: the group is already gone. EPERM: it is gone and the pid has been
      // recycled into a group we do not own — which is likely precisely when the
      // gateway under test was supposed to exit on its own. Neither means this
      // test failed, and treating EPERM as fatal made cleanup racy.
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ESRCH' && code !== 'EPERM') throw error
    }
  }
  watchGateway(child.pid, `gateway ${args.slice(0, 2).join(' ')}`)
  t.after(async () => {
    forgetGateway(child.pid)
    signal('SIGTERM')
    await Promise.race([settled, delay(6500, undefined, { ref: false })])
    // The CLI may already have exited, leaving its stdio child behind.
    signal('SIGKILL')
    await settled
  })
  // Property tests launch a gateway per generated case and must not leave them
  // all running until the test ends. `t.after` still fires afterwards and
  // tolerates an already-dead group.
  const dispose = async () => {
    forgetGateway(child.pid)
    signal('SIGTERM')
    await Promise.race([settled, delay(6500, undefined, { ref: false })])
    signal('SIGKILL')
    await settled
  }
  const describe = (elapsed: number, polls: number, budget: number) => {
    const state = spawnError
      ? `spawn failed (${spawnError.message})`
      : child.exitCode !== null
        ? `exited with code ${child.exitCode}`
        : child.signalCode !== null
          ? `killed by ${child.signalCode}`
          : 'still running'
    const wrote =
      firstByteAt === null
        ? 'wrote nothing'
        : `wrote ${output.length + errors.length} chars, first ${firstByteAt - spawnedAt}ms after spawn`
    return [
      `pid ${child.pid ?? 'unassigned'}`,
      state,
      wrote,
      `waited ${elapsed}ms of ${budget}ms over ${polls} polls`,
      `${Date.now() - spawnedAt}ms since spawn`,
    ].join('; ')
  }
  const controlStart = async () => {
    const probeStart = Date.now()
    const probe = spawn(
      process.env.SUPERGATEWAY_TEST_NODE ?? process.execPath,
      ['-e', 'process.stdout.write("up")'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    )
    const outcome = await Promise.race([
      new Promise<string>((resolve) => {
        probe.stdout.once('data', () => resolve(`${Date.now() - probeStart}ms`))
        probe.once('error', (error) =>
          resolve(`could not spawn (${error.message})`),
        )
        probe.once('exit', () =>
          resolve(`silent, exited after ${Date.now() - probeStart}ms`),
        )
      }),
      delay(controlBudget, undefined, { ref: false }).then(
        () => `still silent after ${controlBudget}ms`,
      ),
    ])
    try {
      probe.kill('SIGKILL')
    } catch {
      // Already gone; the measurement is what matters.
    }
    return outcome
  }
  const waitFor = async (predicate: () => boolean, description: string) => {
    const startedAt = Date.now()
    const budget = readyTimeout()
    const deadline = startedAt + budget
    // The poll count separates "the gateway is stuck" from "this whole runner
    // was starved": the loop asks for 10ms and burns at least that much, so a
    // healthy host completes close to `elapsed / 10` passes. Far fewer means
    // the test process itself was not being scheduled, and the gateway never
    // had the CPU to reach its first log line either.
    let polls = 0
    while (!predicate()) {
      if (
        child.exitCode !== null ||
        child.signalCode !== null ||
        spawnError ||
        Date.now() > deadline
      ) {
        const state = describe(Date.now() - startedAt, polls, budget)
        const control = await controlStart()
        throw Error(
          `Gateway did not ${description} [${state}; bare node start took ${control}]:\n${output}\n${errors}`,
        )
      }
      polls++
      await delay(10)
    }
  }
  return {
    child,
    exited,
    signal,
    dispose,
    waitFor,
    output: () => output,
    errors: () => errors,
    ready: () =>
      waitFor(
        () => /Listening on port|Stdio server listening/.test(output + errors),
        'become ready',
      ),
  }
}

// Probe the same wildcard address the gateway binds, outside the usual OS
// outgoing ephemeral range and above Fetch-blocked ports. A loopback port-0 probe can pick an IPv6-occupied
// port or one that a subsequent HTTP connection claims before gateway startup.
// This is still a probe, not a reservation; keep previously issued ports out
// of reuse for the rest of this test process.
const issued = new Set<number>()

export async function unusedPort() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const port = randomInt(20000, 32768)
    if (issued.has(port)) continue
    const server = createServer()
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, resolve)
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') continue
      throw error
    }
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    issued.add(port)
    return port
  }
  throw Error('Could not find an unused gateway test port')
}

export const peerCommand = 'node tests/helpers/mock-mcp-server.js stdio'
export async function stdioRpc(
  gateway: ReturnType<typeof launchGateway>,
  message: { id: string | number; [key: string]: unknown },
) {
  const response = () =>
    gateway
      .output()
      .split('\n')
      .slice(0, -1)
      .filter((line) => line.startsWith('{'))
      .map((line) => JSON.parse(line))
      .find((result) => result.id === message.id)
  gateway.child.stdin.write(JSON.stringify(message) + '\n')
  await gateway.waitFor(
    () => Boolean(response()),
    `reply to request ${message.id}`,
  )
  return response()
}

export const initialize = (id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'e2e', version: '1.0.0' },
  },
})

export async function rpc(url: string, message: object, session?: string) {
  const response = await fetch(url, {
    method: 'POST',
    signal: AbortSignal.timeout(5000),
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(message),
  })
  const text = await response.text()
  const messages = response.headers
    .get('content-type')
    ?.includes('text/event-stream')
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => JSON.parse(line.slice(5)))
    : text
      ? [JSON.parse(text)]
      : []
  return { response, messages }
}
