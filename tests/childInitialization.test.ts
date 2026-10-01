import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import {
  ChildInitialization,
  DEFAULT_PROTOCOL_VERSION,
} from '../src/lib/childInitialization.js'
import type { Logger } from '../src/types.js'

const setup = () => {
  const written: JSONRPCMessage[] = []
  const infos: string[] = []
  const errors: unknown[][] = []
  const logger = {
    info: (...args: unknown[]) => infos.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args),
  } as unknown as Logger
  const init = new ChildInitialization(
    (message) => written.push(message),
    logger,
    'Session s',
  )
  // The gateway's own initialize, once written.
  const gatewayInitialize = () =>
    written.find(
      (m) => 'method' in m && m.method === 'initialize' && 'id' in m,
    ) as {
      id: string
      params: { protocolVersion: string; clientInfo: { name: string } }
    }
  return { written, infos, errors, init, gatewayInitialize }
}

const request = (id: number, method = 'tools/list'): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method,
})
const initialized: JSONRPCMessage = {
  jsonrpc: '2.0',
  method: 'notifications/initialized',
}
const clientInitialize: JSONRPCMessage = {
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: { sampling: {} },
    clientInfo: { name: 'client', version: '1' },
  },
}

test('a client that initializes is passed through untouched', () => {
  const { written, init } = setup()
  init.fromClient(clientInitialize, '2025-06-18')
  // Its reply is the client's, not the gateway's.
  assert.equal(
    init.fromChild({ jsonrpc: '2.0', id: 0, result: {} } as JSONRPCMessage),
    false,
  )
  init.fromClient(initialized)
  init.fromClient(request(1))
  assert.deepEqual(written, [clientInitialize, initialized, request(1)])
})

test('a ping before initialize is passed through and decides nothing', () => {
  // The spec lets a client ping before initializing, and servers answer it.
  const { written, init } = setup()
  init.fromClient(request(1, 'ping'))
  init.fromClient(clientInitialize)
  init.fromClient(request(2, 'ping'))
  assert.deepEqual(
    written,
    [request(1, 'ping'), clientInitialize, request(2, 'ping')],
    'the client initializes the child itself, once',
  )

  // A ping followed by anything else is still a client that did not initialize.
  const other = setup()
  other.init.fromClient(request(1, 'ping'))
  other.init.fromClient(request(2))
  assert.deepEqual(other.written.slice(0, 1), [request(1, 'ping')])
  assert.equal(other.gatewayInitialize().params.clientInfo.name, 'supergateway')
})

test('replies and pings are never held, even while the gateway initializes', () => {
  // A server may ping the client while it initializes, and answers the
  // gateway's initialize only once the client has replied. Holding that reply
  // until the handshake finished would leave each side waiting for the other.
  const { written, init, gatewayInitialize } = setup()
  const reply = { jsonrpc: '2.0', id: 'srv-ping', result: {} } as JSONRPCMessage
  init.fromClient(reply)
  assert.deepEqual(written, [reply], 'a reply decides nothing')
  init.fromClient(request(1))
  const own = gatewayInitialize()
  init.fromClient(reply)
  init.fromClient(request(2, 'ping'))
  init.fromClient(request(3))
  assert.deepEqual(
    written.slice(2),
    [reply, request(2, 'ping')],
    'during the handshake, only requests and notifications wait',
  )
  init.fromChild({ jsonrpc: '2.0', id: own.id, result: {} } as JSONRPCMessage)
  assert.deepEqual(written.slice(4), [initialized, request(1), request(3)])
})

test('a first message that is not initialize makes the gateway initialize the child', () => {
  const { written, infos, init, gatewayInitialize } = setup()
  init.fromClient(request(1), '2025-06-18')
  init.fromClient(request(2, 'tools/call'))
  const own = gatewayInitialize()
  assert.equal(
    written.length,
    1,
    "the client's messages wait for the handshake",
  )
  assert.equal(own.params.protocolVersion, '2025-06-18')
  assert.equal(own.params.clientInfo.name, 'supergateway')
  assert.match(infos.join('\n'), /first message is not initialize/)

  // Anything else the child says meanwhile still reaches the client.
  const log = {
    jsonrpc: '2.0',
    method: 'notifications/message',
    params: { level: 'info', data: 'starting' },
  } as JSONRPCMessage
  assert.equal(init.fromChild(log), false)
  assert.equal(
    init.fromChild({ jsonrpc: '2.0', id: 7, result: {} } as JSONRPCMessage),
    false,
    'a reply to anything else is not the handshake',
  )
  assert.equal(
    init.fromChild({
      jsonrpc: '2.0',
      id: own.id,
      method: 'roots/list',
    } as JSONRPCMessage),
    false,
    'a server request that happens to reuse the id is not the handshake',
  )
  assert.equal(
    init.fromChild({ jsonrpc: '2.0', result: {} } as unknown as JSONRPCMessage),
    false,
    'nor is a message with no id',
  )

  assert.equal(
    init.fromChild({
      jsonrpc: '2.0',
      id: own.id,
      result: {},
    } as JSONRPCMessage),
    true,
    "the answer to the gateway's initialize is swallowed",
  )
  assert.deepEqual(written.slice(1), [
    initialized,
    request(1),
    request(2, 'tools/call'),
  ])
  assert.match(infos.join('\n'), /server initialized by the gateway/)
  assert.equal(
    init.fromChild({
      jsonrpc: '2.0',
      id: own.id,
      result: {},
    } as JSONRPCMessage),
    false,
    'only once',
  )
})

test("after the gateway initialized, the client's own initialized notification is dropped", () => {
  const { written, infos, init, gatewayInitialize } = setup()
  init.fromClient(initialized)
  init.fromChild({
    jsonrpc: '2.0',
    id: gatewayInitialize().id,
    result: {},
  } as JSONRPCMessage)
  init.fromClient(initialized)
  // One carrying an id is a request, and the server answers it.
  const asRequest = {
    jsonrpc: '2.0',
    id: 9,
    method: 'notifications/initialized',
  } as JSONRPCMessage
  init.fromClient(asRequest)
  const cancelled = {
    jsonrpc: '2.0',
    method: 'notifications/cancelled',
    params: { requestId: 1 },
  } as JSONRPCMessage
  init.fromClient(cancelled)
  assert.deepEqual(written.slice(1), [initialized, asRequest, cancelled])
  assert.equal(
    infos.filter((line) => /dropped the client's initialized/.test(line))
      .length,
    2,
    'the one held during the handshake and the one after it',
  )
})

test('with no version named, the child is initialized with the SSE-era default', () => {
  const { init, gatewayInitialize } = setup()
  init.fromClient(request(1))
  assert.equal(
    gatewayInitialize().params.protocolVersion,
    DEFAULT_PROTOCOL_VERSION,
  )
  assert.equal(DEFAULT_PROTOCOL_VERSION, '2024-11-05')
})

test('an initialize without an id is a notification and does not count as the handshake', () => {
  const { written, init, gatewayInitialize } = setup()
  const { id: _id, ...notification } = clientInitialize as { id: number }
  init.fromClient(notification as unknown as JSONRPCMessage)
  assert.equal(written.length, 1)
  assert.equal(gatewayInitialize().params.clientInfo.name, 'supergateway')
})

test("a server that refuses the gateway's initialize still gets the client's messages", () => {
  const { written, errors, init, gatewayInitialize } = setup()
  init.fromClient(request(1))
  const refusal = { code: -32602, message: 'Unsupported protocol version' }
  assert.equal(
    init.fromChild({
      jsonrpc: '2.0',
      id: gatewayInitialize().id,
      error: refusal,
    } as JSONRPCMessage),
    true,
  )
  // The server answers the client's request itself, with its own error.
  assert.deepEqual(written.slice(1), [initialized, request(1)])
  assert.equal(errors.length, 1)
  assert.deepEqual(errors[0][1], refusal)
})

test('a child taken over from an identically initialized client needs no handshake', () => {
  const { written, init } = setup()
  init.adopted()
  init.fromClient(initialized)
  init.fromClient(request(1))
  assert.deepEqual(
    written,
    [initialized, request(1)],
    "the client's messages go straight through, its initialized included",
  )
})
