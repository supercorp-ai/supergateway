import { randomUUID } from 'node:crypto'
import {
  JSONRPCMessage,
  isInitializedNotification,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from './getVersion.js'
import { isHandshake } from './childHandoff.js'

// The version the SSE transport was defined in. A client that negotiated a
// later one names it on every request after initialize (from 2025-06-18 on).
export const DEFAULT_PROTOCOL_VERSION = '2024-11-05'

export const createInitializeRequest = (
  id: string | number,
  protocolVersion: string,
): JSONRPCMessage => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    protocolVersion,
    capabilities: {},
    clientInfo: {
      name: 'supergateway',
      version: getVersion(),
    },
  },
})

export const createInitializedNotification = (): JSONRPCMessage => ({
  jsonrpc: '2.0',
  method: 'notifications/initialized',
})

/**
 * Initializes a per-connection child whose client never does (GW-034).
 *
 * Since 4.1.0 each SSE and WebSocket connection gets its own child. A client
 * that reconnects gets a new one, and the TypeScript SDK's SSE client
 * reconnects by itself after any dropped stream (a proxy's idle cut, a network
 * blip), adopts the new endpoint and carries on without a second initialize.
 * The new child has never been initialized, and a server that enforces the
 * handshake (every Python SDK server) rejects each call with "Invalid request
 * parameters". Before 4.1.0 the one shared child had been initialized long
 * before, so this worked.
 *
 * So when a child's first message is not an initialize request, the gateway
 * initializes it first, as stateless HTTP does for every request's child, and
 * forwards the client's messages once the child has answered. A client that
 * does initialize is passed straight through, exactly as before.
 */
export class ChildInitialization {
  private state: 'new' | 'initializing' | 'ready' = 'new'
  private initializedHere = false
  private readonly held: JSONRPCMessage[] = []
  private readonly initializeId = `supergateway-initialize:${randomUUID()}`

  constructor(
    private readonly write: (message: JSONRPCMessage) => void,
    private readonly logger: Logger,
    private readonly label: string,
  ) {}

  /**
   * A message from the client. `protocolVersion` is the version the client
   * named on this request, if any; it is used only when the gateway has to
   * initialize the child itself.
   */
  fromClient(message: JSONRPCMessage, protocolVersion?: string): void {
    if (this.state === 'ready') {
      this.forward(message)
      return
    }
    // Never held, and never a reason to initialize. A reply answers a request
    // the server already made, and a server may make one (a ping) while it is
    // still initializing: holding the reply until the handshake finished would
    // leave each side waiting for the other. A ping is the one request a client
    // may send before initialize, and servers answer it (the Python SDK does);
    // it says nothing about whether this client will initialize.
    if (!('method' in message) || message.method === 'ping') {
      this.write(message)
      return
    }
    if (this.state === 'initializing') {
      this.held.push(message)
      return
    }
    // An initialize without an id is a notification and gets no answer, so
    // it cannot stand for the handshake.
    if (isHandshake(message)) {
      this.state = 'ready'
      this.write(message)
      return
    }
    this.state = 'initializing'
    this.held.push(message)
    const version = protocolVersion ?? DEFAULT_PROTOCOL_VERSION
    this.logger.info(
      `${this.label}: first message is not initialize; initializing the server (protocol ${version})`,
    )
    this.write(createInitializeRequest(this.initializeId, version))
  }

  /**
   * The client's initialize was answered by a child an earlier client had
   * initialized identically (GW-035), so this child needs no handshake.
   */
  adopted(): void {
    this.state = 'ready'
  }

  /**
   * A message from the child. Returns true for the answer to the gateway's own
   * initialize, which the client never asked for and must not receive.
   */
  fromChild(message: JSONRPCMessage): boolean {
    if (
      this.state !== 'initializing' ||
      'method' in message ||
      !('id' in message) ||
      message.id !== this.initializeId
    )
      return false
    if ('error' in message)
      this.logger.error(
        `${this.label}: the server refused the gateway's initialize:`,
        message.error,
      )
    else this.logger.info(`${this.label}: server initialized by the gateway`)
    this.state = 'ready'
    this.initializedHere = true
    this.write(createInitializedNotification())
    // The client's own messages, in the order they arrived.
    this.held.splice(0).forEach((held) => this.forward(held))
    return true
  }

  private forward(message: JSONRPCMessage) {
    // The gateway already sent notifications/initialized to a child it
    // initialized. The client's copy would be a second one, and a server that
    // sets up on initialized would do it twice. One carrying an id is a
    // request, and is passed on like any other.
    if (
      this.initializedHere &&
      !('id' in message) &&
      isInitializedNotification(message)
    ) {
      this.logger.info(
        `${this.label}: dropped the client's initialized notification; the gateway initialized this server`,
      )
      return
    }
    this.write(message)
  }
}
