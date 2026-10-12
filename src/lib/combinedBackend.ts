import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Peer, StartPeer } from './childHandoff.js'
import {
  LISTS,
  RpcError,
  type ListMethod,
  type Params,
} from './combinedRules.js'

/** One of the servers combined on an entry's URL, started when a session is. */
export interface CombinedMember {
  name: string
  start: () => StartPeer
}

export type Id = string | number

/** One combined server within a session: its peer and what it declared. */
export class Backend {
  peer!: Peer
  version = ''
  capabilities: Record<string, unknown> = {}
  instructions: string | undefined
  /** Stopped, failed, or left out: nothing more goes to it or comes from it. */
  gone = false
  /** The client's ids for the requests this server sent it. */
  readonly sent = new Map<Id, string>()
  private asks = 0
  private readonly asked = new Map<
    string,
    { resolve: (result: Params) => void; reject: (error: Error) => void }
  >()

  constructor(readonly member: CombinedMember) {}

  get name() {
    return this.member.name
  }

  /** A request of the gateway's own, and its result. */
  ask(method: string, params: Params | undefined): Promise<Params> {
    const id = `sgw:${++this.asks}`
    return new Promise((resolve, reject) => {
      this.asked.set(id, { resolve, reject })
      this.peer.write({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage)
    })
  }

  /** Whether `message` answered one of the gateway's own requests. */
  settle(message: { id?: Id; result?: Params; error?: Params }): boolean {
    const waiting = this.asked.get(message.id as string)
    if (!waiting) return false
    this.asked.delete(message.id as string)
    if (message.error)
      waiting.reject(
        new RpcError(
          message.error.code,
          message.error.message,
          message.error.data,
        ),
      )
    else waiting.resolve(message.result ?? {})
    return true
  }

  /** Nothing the gateway asked will be answered now. */
  abandon(reason: string) {
    for (const waiting of this.asked.values()) waiting.reject(new Error(reason))
    this.asked.clear()
  }

  /** Every page of one of its lists. */
  async listAll(method: ListMethod): Promise<unknown[]> {
    const items: unknown[] = []
    const seen = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await this.ask(
        method,
        cursor === undefined ? {} : { cursor },
      )
      const listed = page[LISTS[method].key]
      if (Array.isArray(listed)) items.push(...listed)
      // A server that repeats a cursor would be asked forever.
      if (cursor !== undefined) seen.add(cursor)
      cursor = seen.has(page.nextCursor) ? undefined : page.nextCursor
    } while (typeof cursor === 'string')
    return items
  }
}
