import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { relayClientMessage } from '../src/lib/relayClientMessage.js'
import { Logger } from '../src/types.js'

/**
 * Both stdio bridges classified anything that was not a request as "not ours"
 * and wrote it to stdout — the direction it had just arrived from. The client
 * got its own message back and the server never got it at all. MCP Inspector
 * showed a `SERVER → CLIENT notifications/initialized` on every connection
 * because of it, which is a message a server may not send.
 */
const recorder = () => {
  const info: unknown[][] = []
  const errors: unknown[][] = []
  const logger: Logger = {
    info: (...args: unknown[]) => info.push(args),
    error: (...args: unknown[]) => errors.push(args),
  }
  return { info, errors, logger }
}

test('the client’s initialized notification is absorbed, not relayed or echoed', async () => {
  const { info, errors, logger } = recorder()
  const sent: JSONRPCMessage[] = []
  await relayClientMessage({
    message: { jsonrpc: '2.0', method: 'notifications/initialized' },
    send: async (message) => {
      sent.push(message)
    },
    label: 'SSE',
    logger,
  })
  // `Client.connect` sends its own as the last step of the handshake, so
  // relaying this copy would deliver a second one to a server that has seen it.
  assert.deepEqual(sent, [])
  assert.deepEqual(errors, [])
  assert.deepEqual(info, [
    ['Client initialized; SSE handshake already sent one'],
  ])
})

test('every other client notification reaches the server', async () => {
  const { errors, logger } = recorder()
  const sent: JSONRPCMessage[] = []
  const cancelled = {
    jsonrpc: '2.0' as const,
    method: 'notifications/cancelled',
    params: { requestId: 7, reason: 'user cancelled' },
  }
  await relayClientMessage({
    message: cancelled,
    send: async (message) => {
      sent.push(message)
    },
    label: 'Streamable HTTP',
    logger,
  })
  // Previously this was written back to the client, so the server kept working
  // on a request the client had already abandoned.
  assert.deepEqual(sent, [cancelled])
  assert.deepEqual(errors, [])
})

test('a response to a server-initiated request reaches the server', async () => {
  const { errors, logger } = recorder()
  const sent: JSONRPCMessage[] = []
  // A roots/list answer, say: it carries an id and no method, so the old
  // classifier called it "not a request" and returned it to its own sender.
  const reply = { jsonrpc: '2.0' as const, id: 3, result: { roots: [] } }
  await relayClientMessage({
    message: reply,
    send: async (message) => {
      sent.push(message)
    },
    label: 'SSE',
    logger,
  })
  assert.deepEqual(sent, [reply])
  assert.deepEqual(errors, [])
})

test('a message that arrives before the upstream connects is reported, not thrown', async () => {
  const { errors, logger } = recorder()
  await relayClientMessage({
    message: { jsonrpc: '2.0', method: 'notifications/cancelled' },
    send: undefined,
    label: 'SSE',
    logger,
  })
  assert.equal(errors.length, 1)
  assert.match(String(errors[0][0]), /before SSE connected/)
})

test('a failed relay is logged and does not take the bridge down', async () => {
  const { errors, logger } = recorder()
  const fault = new Error('upstream gone')
  // The client is still connected and its next request deserves an answer, so
  // a send failure must not escape into the bridge's message handler.
  await relayClientMessage({
    message: { jsonrpc: '2.0', method: 'notifications/cancelled' },
    send: async () => {
      throw fault
    },
    label: 'Streamable HTTP',
    logger,
  })
  assert.deepEqual(errors, [
    ['Could not relay a client message to Streamable HTTP:', fault],
  ])
})
