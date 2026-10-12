import type { Peer, StartPeer, ChildOwner } from './peer.js'
import {
  type JSONRPCMessage,
  type InitializeRequest,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'

/**
 * Whether a client's message is an initialize request with an id, the
 * handshake a child answers; `isInitializeRequest` also accepts one without.
 */
export const isHandshake = (
  message: JSONRPCMessage,
): message is JSONRPCMessage & InitializeRequest & { id: string | number } =>
  isInitializeRequest(message) && 'id' in message

// Whether a message from the child is its response to the request with this
// id.
export const isResponseTo = (message: any, id: string | number | undefined) =>
  !('method' in message) && 'id' in message && message.id === id

/**
 * One server, delivered to whichever owner holds it.
 *
 * It also remembers the initialize request the server received and whether
 * the server has answered it, which is what decides whether a server abandoned
 * by its client can be handed to the next one (GW-035).
 */
export class ChildLink {
  initialize?: { id: string | number; params: unknown }
  answered = false
  readonly peer: Peer
  readonly stop: () => Promise<void>

  constructor(
    start: StartPeer,
    public owner: ChildOwner,
  ) {
    this.peer = start({
      message: (message, line) => {
        if (isResponseTo(message, this.initialize?.id)) this.answered = true
        this.owner.message(message, line)
      },
      nonJson: (line) => this.owner.nonJson(line),
      stderr: (text) => this.owner.stderr(text),
      failure: (kind, err) => this.owner.failure(kind, err),
      exit: (code, signal) => this.owner.exit(code, signal),
      output: () => this.owner.output(),
    })
    this.stop = () => this.peer.stop()
  }

  /** Whether the server is still running and has not answered its initialize. */
  get initializing(): boolean {
    return this.initialize !== undefined && !this.answered && !this.peer.gone
  }

  write(message: JSONRPCMessage) {
    // Only the first initialize is the handshake the child is answering.
    if (!this.initialize && isHandshake(message))
      this.initialize = { id: message.id, params: message.params }
    this.peer.write(message)
  }
}
