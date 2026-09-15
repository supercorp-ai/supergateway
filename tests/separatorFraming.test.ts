import { test } from 'node:test'
import assert from 'node:assert/strict'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * Issue #91 / GW-021: the bytes on the wire, measured rather than assumed.
 *
 * Two reporters saw a tool result arrive truncated with U+2028 visible at the
 * cut, and the issue sat for months without a mechanism established. PR #93
 * proposed `sanitizeJsonObject` as the fix; it corrupts values, so it matters a
 * great deal whether the gateway is the thing that is wrong.
 *
 * It is not. The gateway relays the separators raw and the reply is a single
 * well-formed `data:` line, because the SSE specification splits an event
 * stream on CR and LF and nothing else. A consumer that splits on Unicode line
 * terminators instead — Python's `str.splitlines()`, the standard gotcha — cuts
 * that one line into three and fails to parse the first piece.
 *
 * Both halves are asserted here, because only having both distinguishes "the
 * gateway corrupts data" from "some clients cannot read correct data", and
 * those call for opposite fixes. Escaping the separators at serialisation would
 * be a courtesy to naive clients — an escaped U+2028 and the raw character are the same
 * JSON value — but it is not a correctness fix, and these tests are what would
 * keep that change honest if it lands.
 */
const SEPARATORS = 'before\u2028middle\u2029after'

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
  'the gateway relays U+2028/U+2029 raw, in one SSE data line',
  { timeout: 60000 },
  async (t) => {
    const raw = await callSeparators(t)
    const bytes = Buffer.from(raw, 'utf8')

    assert.ok(
      bytes.includes(Buffer.from([0xe2, 0x80, 0xa8])),
      'U+2028 was not relayed raw; the serialiser now escapes it',
    )
    assert.ok(
      bytes.includes(Buffer.from([0xe2, 0x80, 0xa9])),
      'U+2029 was not relayed raw; the serialiser now escapes it',
    )

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
  'a client that splits on Unicode line terminators breaks on a correct frame',
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
    assert.throws(
      () => JSON.parse(naive[0].slice(5)),
      /Unterminated string|Unexpected end|JSON/,
      'the naive splitter no longer truncates — if the serialiser has started ' +
        'escaping the separators, that is the change, and #91 is closed',
    )
    // The damage is the splitter's alone: the complete value is right there in
    // the bytes it was handed.
    assert.ok(
      raw.includes(SEPARATORS),
      'the complete value is present in the response the client truncated',
    )
  },
)
