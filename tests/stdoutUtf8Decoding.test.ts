import { test } from 'node:test'
import assert from 'node:assert/strict'
import { observeGateway } from './helpers/observed-gateway.js'
import { initialize } from './helpers/gateway-process.js'

// Real gateway callbacks and Node decoder; only processes and network transports
// are controlled so every byte boundary is delivered without pipe coalescing.
test('all stdout readers preserve every UTF-8 byte split and keep child decoder state separate', async (t) => {
  const b = observeGateway(t)
  const ws: { sent: unknown[] }[] = []
  t.mock.module('http', {
    namedExports: { createServer: () => ({ listen() {} }) },
  })
  t.mock.module(new URL('../src/server/websocket.js', import.meta.url).href, {
    namedExports: {
      WebSocketServerTransport: class {
        sent: unknown[] = []
        constructor() {
          ws.push(this)
        }
        async send(message: unknown) {
          this.sent.push(structuredClone(message))
        }
      },
    },
  })
  const common = {
    stdioCmd: 'controlled',
    port: 0,
    logger: b.logger,
    corsOrigin: false,
    healthEndpoints: [],
    headers: {},
    streamableHttpPath: '/mcp',
    sessionTimeout: null,
    protocolVersion: '2024-11-05',
    baseUrl: '',
    ssePath: '/sse',
    messagePath: '/message',
  }
  // Includes scalar-width boundaries, surrogate-range neighbours, combining
  // marks, an astral scalar, and Unicode separators that are not line framing.
  const text =
    'A\u0080\u07ff\u0800\ud7ff\ue000\uffff\u{10000}\u{10ffff}ą€🙂漢e\u0301\u2028\u2029Z'
  const reply = { jsonrpc: '2.0', id: 7, result: { text } }
  const bytes = Buffer.from(JSON.stringify(reply) + '\r\n')
  const notice = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { data: text },
  }

  for (const mode of ['sse', 'stateful', 'stateless', 'ws'] as const) {
    const start =
      mode === 'sse'
        ? (await import('../src/gateways/stdioToSse.js')).stdioToSse
        : mode === 'stateful'
          ? (await import('../src/gateways/stdioToStatefulStreamableHttp.js'))
              .stdioToStatefulStreamableHttp
          : mode === 'stateless'
            ? (
                await import(
                  '../src/gateways/stdioToStatelessStreamableHttp.js'
                )
              ).stdioToStatelessStreamableHttp
            : (await import('../src/gateways/stdioToWs.js')).stdioToWs
    await start(common)
    let opened = false
    const open = async () => {
      if (mode === 'stateful' || mode === 'stateless') {
        await b.request('POST', '/mcp', { body: initialize() })
      } else {
        if (opened) await start(common)
        if (mode === 'sse') await b.request('GET', '/sse')
      }
      opened = true
      return {
        child: b.children.at(-1)!,
        transport: mode === 'ws' ? ws.at(-1)! : b.transports.at(-1)!,
      }
    }
    const a = await open(),
      other = await open()
    const emit = (target: typeof a, chunk: Buffer) =>
      target.child.stdout.emit('data', chunk)
    for (let cut = 0; cut < bytes.length; cut++) {
      a.transport.sent.length = 0
      emit(a, bytes.subarray(0, cut))
      assert.deepEqual(
        a.transport.sent,
        [],
        `${mode}: no frame before LF at ${cut}`,
      )
      emit(a, bytes.subarray(cut))
      assert.deepEqual(
        a.transport.sent,
        [reply],
        `${mode}: exact value at ${cut}`,
      )
    }
    a.transport.sent.length = 0
    for (const byte of bytes) emit(a, Buffer.from([byte]))
    assert.deepEqual(a.transport.sent, [reply], `${mode}: one byte per event`)

    a.transport.sent.length = 0
    emit(
      a,
      Buffer.from(
        '\n \r\n' +
          JSON.stringify(notice) +
          '\n' +
          JSON.stringify(reply) +
          '\n',
      ),
    )
    assert.deepEqual(
      a.transport.sent,
      [notice, reply],
      `${mode}: coalesced frames and blank lines`,
    )

    a.transport.sent.length = 0
    // Interleave two incomplete, different four-byte scalars. Sharing a decoder
    // across children corrupts one or both messages, even with separate strings.
    const first = Buffer.from(
      JSON.stringify({ ...reply, result: { text: '🙂' } }) + '\n',
    )
    const secondReply = { ...reply, result: { text: '🚀' } }
    const second = Buffer.from(JSON.stringify(secondReply) + '\n')
    const left = first.indexOf(Buffer.from('🙂')) + 2
    const right = second.indexOf(Buffer.from('🚀')) + 1
    emit(a, first.subarray(0, left))
    emit(other, second.subarray(0, right))
    assert.deepEqual(
      [a.transport.sent, other.transport.sent],
      [[], []],
      `${mode}: hold incomplete messages`,
    )
    emit(other, second.subarray(right))
    emit(a, first.subarray(left))
    assert.deepEqual(
      other.transport.sent,
      [secondReply],
      `${mode}: second child remains independent`,
    )
    assert.deepEqual(
      a.transport.sent,
      [{ ...reply, result: { text: '🙂' } }],
      `${mode}: first child remains independent`,
    )

    a.transport.sent.length = 0
    emit(a, Buffer.from('not JSON\n'))
    emit(a, bytes)
    assert.deepEqual(
      a.transport.sent,
      [reply],
      `${mode}: valid frame after malformed line`,
    )
    const before = a.transport.sent.length
    emit(a, Buffer.from('{"jsonrpc":"2.0","id":8,"result":{"text":"'))
    emit(a, Buffer.from([0xf0, 0x9f]))
    a.child.stdout.emit('end')
    assert.equal(
      a.transport.sent.length,
      before,
      `${mode}: EOF does not forward an unfinished frame`,
    )
  }
})
