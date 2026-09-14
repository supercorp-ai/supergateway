import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'
import { watchGateway, forgetGateway } from './leak-check.js'

// Launch the actual compiled CLI. A separate process group also lets teardown
// reap the shell and stdio MCP child, even when an assertion fails.
export function launchGateway(
  t: TestContext,
  args: string[],
  env?: Record<string, string>,
) {
  const grouped = process.platform !== 'win32'
  const child = spawn(process.execPath, ['dist/index.js', ...args], {
    stdio: 'pipe',
    detached: grouped,
    env: env ? { ...process.env, ...env } : process.env,
  })
  let output = ''
  let errors = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    output += chunk
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    errors += chunk
  })
  const exited = new Promise<{ code: number | null; signal: string | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => resolve({ code, signal }))
    },
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
    await Promise.race([exited, delay(1000)])
    // The CLI may already have exited, leaving its stdio child behind.
    signal('SIGKILL')
    await exited
  })
  // Property tests launch a gateway per generated case and must not leave them
  // all running until the test ends. `t.after` still fires afterwards and
  // tolerates an already-dead group.
  const dispose = async () => {
    forgetGateway(child.pid)
    signal('SIGKILL')
    await exited.catch(() => {})
  }
  const waitFor = async (predicate: () => boolean, description: string) => {
    const deadline = Date.now() + 8000
    while (!predicate()) {
      if (
        child.exitCode !== null ||
        child.signalCode !== null ||
        Date.now() > deadline
      ) {
        throw Error(`Gateway did not ${description}:\n${output}\n${errors}`)
      }
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

// Binding port 0 and closing leaves a window in which the OS can hand the same
// port to someone else, and with 55 files churning the ephemeral range it will.
// Remembering what this process has already issued removes the self-collision,
// which is the common case: a gateway that lost the race never binds, and the
// test fails eight seconds later saying only that it "did not become ready".
const issued = new Set<number>()

export async function unusedPort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = (server.address() as { port: number }).port
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
    if (!issued.has(port)) {
      issued.add(port)
      return port
    }
  }
  throw Error('Could not find a port this run has not already handed out')
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
