import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, ChildProcess } from 'child_process'
import { readdirSync, readFileSync } from 'fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

// Regression test for #108: in stateless streamableHttp mode the child spawned
// per request must be reaped when the HTTP response ends. Before the fix these
// children accumulated without bound. Process inspection is Linux-only.

const PORT = 11071
const MCP_URL = `http://localhost:${PORT}/mcp`
const CHILD_CMDLINE = 'node tests/helpers/mock-mcp-server.js stdio'
let gatewayProc: ChildProcess

const countChildren = (): number => {
  let n = 0
  for (const pid of readdirSync('/proc')) {
    if (!/^\d+$/.test(pid)) continue
    try {
      const cl = readFileSync(`/proc/${pid}/cmdline`)
        .toString('utf8')
        .replace(/\0/g, ' ')
        .trim()
      if (cl === CHILD_CMDLINE) n++
    } catch {
      /* process gone */
    }
  }
  return n
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
    { stdio: 'ignore', shell: false },
  )
  gatewayProc.unref()
})

test.after(async () => {
  gatewayProc.kill('SIGINT')
  await new Promise((r) => gatewayProc.once('exit', r))
})

test(
  '#108 stateless children are reaped after each request (no leak)',
  { skip: process.platform !== 'linux' },
  async () => {
    await new Promise((r) => setTimeout(r, 2000))
    const CYCLES = 12
    for (let i = 0; i < CYCLES; i++) {
      const transport = new StreamableHTTPClientTransport(new URL(MCP_URL))
      const client = new Client({ name: 'reap-test', version: '1.0.0' })
      await client.connect(transport)
      await client.callTool({ name: 'add', arguments: { a: 1, b: 2 } })
      await client.close()
      await transport.close()
    }
    // allow the reaper's SIGTERM/close handlers to run
    await new Promise((r) => setTimeout(r, 3000))
    const remaining = countChildren()
    assert.ok(
      remaining <= 2,
      `expected <=2 residual children after ${CYCLES} cycles, found ${remaining} (leak)`,
    )
  },
)
