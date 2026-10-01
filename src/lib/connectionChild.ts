import type { ChildProcessWithoutNullStreams } from 'child_process'
import {
  JSONRPCMessage,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { ChildHandoff, ChildLink, type ChildOwner } from './childHandoff.js'
import { ChildInitialization } from './childInitialization.js'

/**
 * The child of one SSE or WebSocket connection, which since 4.1.0 has its own:
 * its stdio (ChildLink), the handshake the gateway makes when a reconnected
 * client never does (GW-034), and the handoff of a child its client abandoned
 * during initialize to an identical retry (GW-035). Both gateways did all of
 * this, the same way, inline.
 */
export class ConnectionChild {
  private link: ChildLink
  private readonly initialization: ChildInitialization
  // What the gateway's owner sees: the child's messages, after the handshake
  // has taken the answer to the gateway's own initialize out.
  private readonly owner: ChildOwner
  private received = 0
  // Whether all the client has sent is its initialize request.
  private onlyInitialize = false

  constructor(
    child: ChildProcessWithoutNullStreams,
    stop: () => Promise<void>,
    owner: ChildOwner,
    private readonly handoff: ChildHandoff,
    logger: Logger,
    private readonly label: string,
  ) {
    this.initialization = new ChildInitialization(
      (message) => this.link.write(message),
      logger,
      label,
    )
    this.owner = {
      ...owner,
      message: (message, line) => {
        if (this.initialization.fromChild(message)) return
        owner.message(message, line)
      },
    }
    this.link = new ChildLink(child, stop, this.owner)
  }

  /**
   * A message from the client. `protocolVersion` is the version the client
   * named on it, if any, for a handshake the gateway makes itself.
   */
  fromClient(message: JSONRPCMessage, protocolVersion?: string) {
    this.received++
    this.onlyInitialize =
      this.received === 1 && isInitializeRequest(message) && 'id' in message
    if (this.onlyInitialize) {
      const adopted = this.handoff.adopt(message, this.owner, this.label)
      if (adopted) {
        // This connection's own child has been sent nothing.
        this.handoff.discard(this.link, this.label)
        this.link = adopted
        this.initialization.adopted()
        return
      }
    }
    this.initialization.fromClient(message, protocolVersion)
  }

  /**
   * The connection is over. Only its client leaving can hand the child on;
   * one that ends because its child failed stops it.
   */
  end(clientLeft: boolean) {
    if (clientLeft)
      this.handoff.release(this.link, this.onlyInitialize, this.label)
    else void this.link.stop()
  }
}
