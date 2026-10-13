import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  gatewayTimeout,
  launchGateway,
  requestTimeout,
  unusedPort,
} from './helpers/gateway-process.js'

// The stdio→SSE gateway, end to end against the built CLI: the bytes of a
// reply carrying U+2028/U+2029 as they arrive on the event stream. The
// Streamable HTTP outputs are checked in assertedStatelessGateway.test.ts.

test(
  'stdio→SSE escapes U+2028/U+2029 on its event stream without changing their JSON value',
  { timeout: gatewayTimeout(20000) },
  async (t) => {
    const port = await unusedPort()
    const gateway = launchGateway(t, [
      '--stdio',
      'node tests/clients/battery-peer.mjs',
      '--outputTransport',
      'sse',
      '--port',
      String(port),
    ])
    await gateway.ready()
    const base = `http://127.0.0.1:${port}`
    const closing = new AbortController()
    t.after(() => closing.abort())
    const stream = await fetch(`${base}/sse`, {
      headers: { accept: 'text/event-stream' },
      signal: closing.signal,
    })
    const reader = stream.body!.getReader()
    let raw = Buffer.alloc(0)
    // The stream as bytes, read until `seen` says enough has arrived.
    const until = async (seen: (text: string) => boolean) => {
      const deadline = Date.now() + requestTimeout(10000)
      while (!seen(raw.toString('utf8'))) {
        assert.ok(Date.now() < deadline, `the stream said only: ${raw}`)
        const { value, done } = await reader.read()
        assert.equal(done, false, 'the event stream ended')
        raw = Buffer.concat([raw, value!])
      }
      return raw.toString('utf8')
    }
    const opened = await until((text) => text.includes('\n\n'))
    const endpoint = /^data: (.+)$/m.exec(opened)![1]
    const send = (message: object) =>
      fetch(new URL(endpoint, base), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(requestTimeout(10000)),
      })
    await send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    })
    await until((text) => text.includes('"id":1'))
    await send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    await send({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'separators', arguments: {} },
    })
    const text = await until((said) => /"id":7[^\n]*\n\n/.test(said))
    const separators = 'before middle after'
    assert.deepEqual(
      {
        u2028: raw.includes(Buffer.from([0xe2, 0x80, 0xa8])),
        u2029: raw.includes(Buffer.from([0xe2, 0x80, 0xa9])),
        escaped: text.includes('\\u2028') && text.includes('\\u2029'),
      },
      { u2028: false, u2029: false, escaped: true },
    )
    const reply = text
      .split('\n')
      .filter((line) => line.startsWith('data: {'))
      .map((line) => JSON.parse(line.slice(6)))
      .find((message) => message.id === 7)
    assert.deepEqual(reply.result.content, [{ type: 'text', text: separators }])
  },
)
