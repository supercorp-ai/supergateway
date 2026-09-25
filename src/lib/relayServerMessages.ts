import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/**
 * What the upstream server sends on its own, handed straight to the stdio
 * client: its notifications (logging, progress, list changes, resource updates)
 * and its own requests (sampling, roots, elicitation, ping).
 *
 * Both bridges talk upstream through the SDK's `Client`, and until now every
 * message reached it and nothing else. It has no handlers for any of these, so
 * notifications were dropped and requests were answered "Method not found"
 * without the stdio client ever seeing them. Only responses to the bridge's
 * own requests belong to the `Client`. The stdio client's replies to server
 * requests already travel upstream unchanged (`relayClientMessage`), so ids and
 * progress tokens need no translation.
 *
 * The SDK installs its handler by assigning `transport.onmessage`, and calls
 * whatever was there before as well as its own dispatch, so an earlier handler
 * cannot stop the `Client` from answering. Intercepting the property can.
 * Install this before `Client.connect`.
 */
export function relayServerMessages(
  transport: Transport,
  deliver: (message: JSONRPCMessage) => void,
) {
  let client: Transport['onmessage']
  const relay: Transport['onmessage'] = (message, extra) => {
    if ('method' in message) deliver(message)
    else client!(message, extra)
  }
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    // Nothing until the SDK installs its handler: it reads the old value to
    // chain it, and chaining `relay` into the handler `relay` calls would recurse.
    get: () => client && relay,
    set: (handler: Transport['onmessage']) => {
      client = handler
    },
  })
}
