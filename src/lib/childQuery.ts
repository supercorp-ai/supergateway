import type { JSONRPCResponse, JSONRPCMessage } from './modernSdk.js'
import type { ModernChild } from './upstreamModernChild.js'
import { randomUUID } from 'node:crypto'

/**
 * A request the gateway itself makes of a request's child, whose reply is
 * taken out of the client's stream. While it waits, nothing else the child
 * says reaches the client.
 */
export class ChildQuery {
  private pending:
    | {
        id: string
        resolve: (message: JSONRPCResponse) => void
        reject: (error: Error) => void
      }
    | undefined

  get waiting(): boolean {
    return this.pending !== undefined
  }

  // Not async, so that awaiting it is awaiting the reply itself.
  ask(
    child: ModernChild,
    method: string,
    params: Record<string, unknown>,
  ): Promise<JSONRPCResponse> {
    const id = randomUUID()
    let rejectReply!: (error: Error) => void
    const reply = new Promise<JSONRPCResponse>((resolve, reject) => {
      rejectReply = reject
      this.pending = { id, resolve, reject }
    })
    void child.send({ jsonrpc: '2.0', id, method, params }).catch(rejectReply)
    return reply
  }

  /** A message from the child while waiting: its reply ends the wait. */
  receive(message: JSONRPCMessage) {
    if ('id' in message && message.id === this.pending!.id) {
      const resolve = this.pending!.resolve
      this.pending = undefined
      // A request from the child has already failed the request instead.
      resolve(message as JSONRPCResponse)
    }
  }

  cancel() {
    this.pending?.reject(new Error('Request closed'))
  }
}
