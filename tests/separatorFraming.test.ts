import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

// Issue #91: escape line separators in the SSE wire representation while
// preserving their exact JSON value for standards-compliant SDK clients.
const SEPARATORS = 'before\u2028middle\u2029after'

test(
  'legacy SSE and stateless HTTP preserve separator values for SDK clients',
  { timeout: 60000 },
  async (t) => {
    for (const mode of ['sse', 'stateless'] as const) {
      const port = await unusedPort()
      const gateway = launchGateway(t, [
        '--stdio',
        'node tests/clients/battery-peer.mjs',
        '--port',
        String(port),
        ...(mode === 'stateless'
          ? ['--outputTransport', 'streamableHttp']
          : []),
      ])
      await gateway.ready()
      const client = new Client({
        name: `separators-${mode}`,
        version: '1.0.0',
      })
      const url = new URL(
        `http://127.0.0.1:${port}/${mode === 'sse' ? 'sse' : 'mcp'}`,
      )
      await client.connect(
        mode === 'sse'
          ? new SSEClientTransport(url)
          : new StreamableHTTPClientTransport(url),
      )
      try {
        const result = await client.callTool({
          name: 'separators',
          arguments: {},
        })
        assert.deepEqual(result.content, [{ type: 'text', text: SEPARATORS }])
      } finally {
        await client.close()
      }
    }
  },
)

test(
  'the SDK client receives the original separator characters through the gateway',
  { timeout: 60000 },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/clients/battery-peer.mjs',
      '--port',
      String(port),
      '--outputTransport',
      'streamableHttp',
      '--stateful',
    ])
    await gateway.ready()
    const client = new Client({ name: 'separator-client', version: '1.0.0' })
    t.after(() => client.close())
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`),
      ),
    )
    const result = await client.callTool({ name: 'separators', arguments: {} })
    assert.notEqual(result.isError, true)
    assert.deepEqual(result.content, [{ type: 'text', text: SEPARATORS }])
  },
)

async function callSeparators(t: Parameters<typeof launchGateway>[0]) {
  const port = await unusedPort()
  const gateway = launchGateway(t, [
    '--stdio',
    'node tests/clients/battery-peer.mjs',
    '--port',
    String(port),
    '--outputTransport',
    'streamableHttp',
    '--stateful',
  ])
  await gateway.ready()
  const url = `http://127.0.0.1:${port}/mcp`
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  const send = (body: unknown) =>
    fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })

  const initialized = await send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'separators', version: '1.0.0' },
    },
  })
  await initialized.text()
  headers['mcp-session-id'] = initialized.headers.get('mcp-session-id')!
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' })

  // The raw body, never a parsed one: the whole question is which bytes a
  // client has to cope with, and any SDK would have framed them away already.
  return (
    await send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'separators', arguments: {} },
    })
  ).text()
}

test(
  'SSE escapes U+2028/U+2029 on the wire without changing their JSON value',
  { timeout: 60000 },
  async (t) => {
    const raw = await callSeparators(t)
    const bytes = Buffer.from(raw, 'utf8')

    assert.equal(bytes.includes(Buffer.from([0xe2, 0x80, 0xa8])), false)
    assert.equal(bytes.includes(Buffer.from([0xe2, 0x80, 0xa9])), false)
    assert.ok(raw.includes('\\u2028'))
    assert.ok(raw.includes('\\u2029'))

    // The SSE rule: split on CRLF, CR or LF, and nothing else.
    const lines = raw
      .split(/\r\n|\r|\n/)
      .filter((line) => line.startsWith('data:'))
    assert.equal(
      lines.length,
      1,
      `the reply should be one data line, got ${lines.length}`,
    )
    const payload = JSON.parse(lines[0].slice(5))
    assert.equal(
      payload.result.content[0].text,
      SEPARATORS,
      'the separators did not survive the relay',
    )
  },
)

test(
  'a Unicode line-splitting client can parse the escaped SSE frame',
  { timeout: 60000 },
  async (t) => {
    const raw = await callSeparators(t)

    // What Python's str.splitlines() treats as a line break, beyond CR and LF.
    const naive = raw
      .split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/)
      .filter((line) => line.startsWith('data:'))

    assert.equal(
      naive.length,
      1,
      'the naive splitter should still find exactly one line beginning data:',
    )
    assert.equal(
      JSON.parse(naive[0].slice(5)).result.content[0].text,
      SEPARATORS,
    )
  },
)
