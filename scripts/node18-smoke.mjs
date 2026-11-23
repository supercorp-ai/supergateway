// Supergateway requires Node 20, but npm only warns about that, so people on
// Node 18 still run it. This checks, under Node 18, that the built gateway
// still serves SSE and Streamable HTTP (stateless and stateful): 4.2.3 broke
// Streamable HTTP there (`crypto is not defined`).
//
//   node scripts/node18-smoke.mjs   (run with Node 18, after npm run build)
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { resolve } from 'node:path'

const entry = resolve(process.env.SUPERGATEWAY_TEST_ENTRY ?? 'dist/index.js')
const server = `"${process.execPath}" "${resolve('tests/helpers/mock-mcp-server.js')}" stdio`
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))
const freePort = () =>
  new Promise((done) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => done(port))
    })
  })
const initialize = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'node18-smoke', version: '1' },
  },
}

async function gateway(args, check) {
  const port = await freePort()
  let stderr = ''
  const child = spawn(
    process.execPath,
    [entry, '--stdio', server, '--port', String(port), ...args],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  child.stderr.on('data', (chunk) => (stderr += chunk))
  try {
    for (let tries = 0; ; tries++) {
      try {
        await fetch(`http://127.0.0.1:${port}/`) // any answer: listening
        break
      } catch (error) {
        if (tries > 100) throw error
        await sleep(100)
      }
    }
    await check(port)
  } catch (error) {
    console.error(stderr)
    throw error
  } finally {
    child.kill()
  }
}

const post = (port, body, headers = {}) =>
  fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })

console.log(`Node ${process.version}, ${entry}`)

await gateway(['--outputTransport', 'streamableHttp'], async (port) => {
  const response = await post(port, initialize)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  assert.match(text, /serverInfo/)
  console.log('ok: stateless Streamable HTTP answers initialize')
})

await gateway(
  ['--outputTransport', 'streamableHttp', '--stateful'],
  async (port) => {
    const response = await post(port, initialize)
    const text = await response.text()
    assert.equal(response.status, 200, text)
    const session = response.headers.get('mcp-session-id')
    assert.ok(session, 'a session id')
    const list = await post(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { 'mcp-session-id': session, 'mcp-protocol-version': '2025-03-26' },
    )
    const tools = await list.text()
    assert.equal(list.status, 200, tools)
    assert.match(tools, /"tools"/)
    console.log('ok: stateful Streamable HTTP initializes and lists tools')
  },
)

await gateway([], async (port) => {
  const abort = new AbortController()
  const response = await fetch(`http://127.0.0.1:${port}/sse`, {
    signal: abort.signal,
  })
  assert.equal(response.status, 200)
  const { value } = await response.body.getReader().read()
  abort.abort()
  assert.match(new TextDecoder().decode(value), /event: endpoint/)
  console.log('ok: SSE opens a stream with its endpoint')
})
