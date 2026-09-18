import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'

/**
 * A message the stdio client sent that is not a request.
 *
 * Both bridges classified these as "not a request" and wrote them to stdout,
 * which is the direction they arrived from: the client got its own message
 * back, and the server never got it at all. A `notifications/initialized`
 * travelling server→client is not something a server may send, and MCP
 * Inspector shows one on every connection because of it.
 *
 * Notifications and responses to server-initiated requests both belong
 * upstream. `notifications/initialized` is the exception: `Client.connect`
 * sends its own as the last step of the handshake, so relaying the client's
 * copy would deliver a second one to a server that has already seen it.
 */
export async function relayClientMessage({
  message,
  send,
  label,
  logger,
}: {
  message: JSONRPCMessage
  // Undefined until the upstream client is connected. A message that arrives
  // before then has nowhere to go, and inventing a connection for it would
  // reorder the handshake.
  send: ((message: JSONRPCMessage) => Promise<void>) | undefined
  label: string
  logger: Logger
}): Promise<void> {
  const method = 'method' in message ? message.method : undefined

  if (method === 'notifications/initialized') {
    logger.info(`Client initialized; ${label} handshake already sent one`)
    return
  }

  if (!send) {
    logger.error(
      `Dropped a client message sent before ${label} connected:`,
      message,
    )
    return
  }

  logger.info(`Stdio → ${label}:`, message)

  try {
    await send(message)
  } catch (error) {
    // A relay failure must not take the bridge down: the client is still
    // connected and its next request deserves an answer.
    logger.error(`Could not relay a client message to ${label}:`, error)
  }
}
