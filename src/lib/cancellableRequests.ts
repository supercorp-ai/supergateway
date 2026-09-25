import type {
  JSONRPCMessage,
  RequestId,
} from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../types.js'

/**
 * The stdio client's requests that a bridge has sent upstream and not yet
 * answered, keyed by the client's own id.
 *
 * The bridge's SDK `Client` numbers what it sends upstream itself, so a
 * client's `notifications/cancelled` names an id the server has never seen.
 * Relayed unchanged, it cancelled nothing when the ids differed (string ids,
 * or any client that does not count from 0 like the SDK does), and when they
 * happened to collide, as after a reconnect restarts the bridge's count, it
 * could cancel a different request. The bridge now aborts its own call, and the
 * SDK tells the server which request that was.
 *
 * It is also why a bridge sets no deadline of its own: the SDK's default of 60
 * seconds failed every longer tool call even when the client was willing to
 * wait. The client owns the deadline, and when it gives up, its cancellation
 * arrives here.
 */
export class CancellableRequests {
  private readonly pending = new Map<RequestId, AbortController>()

  constructor(private readonly logger: Logger) {}

  /** Track a request; pass the signal to `Client.request`. */
  begin(id: RequestId): AbortSignal {
    const controller = new AbortController()
    this.pending.set(id, controller)
    return controller.signal
  }

  end(id: RequestId): void {
    this.pending.delete(id)
  }

  /**
   * True when `message` is the client cancelling a request, which is then
   * handled here and must not be relayed.
   */
  cancel(message: JSONRPCMessage): boolean {
    if (!('method' in message) || message.method !== 'notifications/cancelled')
      return false
    const params = message.params as
      | { requestId?: RequestId; reason?: string }
      | undefined
    const controller = this.pending.get(params?.requestId as RequestId)
    // A cancel for a request that already finished, or never existed, is
    // ignored, as the spec asks. Relaying it would name an id upstream that
    // belongs to some other request.
    if (!controller) {
      this.logger.info(
        'Ignored a cancellation for no pending request:',
        message,
      )
      return true
    }
    // Found by its requestId, so the params were there.
    controller.abort(params!.reason ?? 'Cancelled by the client')
    return true
  }
}
