import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Narrowed-reap regression: when the HTTP response ends, the per-request
// SIGKILL sweep must hit ONLY processes still in the request's own session.
// A child that detached (setsid → new session, as `systemd-run` / a daemon
// does) MUST survive; a child left in-session MUST be reaped. Linux-only.

const PORT = 11072
const MCP_URL = `http://localhost:${PORT}/mcp`
const CHILD_CMDLINE = 'node tests/helpers/mock-mcp-server.js stdio'
let gatewayProc: ChildProcess

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test.before(() => {
  gatewayProc = spawn(
    'npm',
    [
      'run',
      'start',
      '--',
      '--stdio',
      CHILD_CMDLINE,
      '--outputTransport',
      'streamableHttp',
      '--port',
      String(PORT),
      '--streamableHttpPath',
      '/mcp',
    ],
    {
      stdio: 'ignore',
      shell: false,
      env: { ...process.env, SUPERGATEWAY_REAP_GRACE_MS: '300' },
    },
  )
  gatewayProc.unref()
})

test.after(async () => {
  gatewayProc.kill('SIGINT')
  await new Promise((r) => gatewayProc.once('exit', r))
})

test(
  'detached (setsid) work survives the reap; in-session work is reaped',
  { skip: process.platform !== 'linux' },
  async () => {
    await new Promise((r) => setTimeout(r, 2000))

    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
    const client = new Client({ name: 'detach-test', version: '1.0.0' })
    await client.connect(transport)
    const result: any = await client.callTool({
      name: 'spawn_probe',
      arguments: {},
    })
    const { detachedPid, inSessionPid } = JSON.parse(result.content[0].text)
    assert.ok(alive(detachedPid), 'sanity: detached sleeper should be running')
    assert.ok(
      alive(inSessionPid),
      'sanity: in-session sleeper should be running',
    )

    // End the request → reapChild: SIGTERM group, then session-scoped SIGKILL.
    await client.close()
    await transport.close()

    // Wait past the grace window (300ms) with margin.
    await new Promise((r) => setTimeout(r, 1500))

    assert.ok(
      alive(detachedPid),
      `detached sleeper ${detachedPid} was killed but should have survived`,
    )
    assert.equal(
      alive(inSessionPid),
      false,
      `in-session sleeper ${inSessionPid} survived but should have been reaped`,
    )

    try {
      process.kill(detachedPid, 'SIGKILL')
    } catch {}
  },
)
