import type {
  ModernRequestInfo,
  ModernMember,
  CombinedModernEntry,
  Request,
} from './combinedModernTypes.js'
import type { ModernChild } from './upstreamModernChild.js'
import type { JSONRPCMessage } from './modernSdk.js'
import type { Logger } from '../types.js'
import { detach, ask } from './combinedModernAsk.js'
import { RpcError, type Params, isList, NAMED } from './combinedRules.js'
import { CombinedModernCatalog } from './combinedModernCatalog.js'
export { combinedSpeaksModern } from './combinedSpeaksModern.js'

export {
  type ModernRequestInfo,
  type ModernMember,
  type CombinedModernEntry,
} from './combinedModernTypes.js'

/**
 * Several servers as one, for one 2026-07-28 request. The rules are the
 * combined session's (combinedPeer): nothing is renamed, the first server
 * listed wins a name, lists are every server's as one page.
 *
 * There is no session, so only the server a request is for is started for
 * it: `server/discover` and the lists go to every server, and a request that
 * names a tool, prompt or resource to the one that has it, by a table the
 * entry's requests share and a list refreshes. A multi-round call keeps its
 * server, which the relay retains with this.
 */
export class CombinedModernChild implements ModernChild {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  /** The server the request was passed to, which a retry is passed to too. */
  private current: ModernChild | undefined
  private readonly open = new Set<ModernChild>()
  private readonly working = new Set<Promise<void>>()
  private asks = 0
  private closed = false
  /** What the servers are as one, and which of them has what. */
  private readonly catalog: CombinedModernCatalog

  constructor(
    private readonly entry: CombinedModernEntry,
    private readonly request: ModernRequestInfo,
    private readonly logger: Logger,
  ) {
    this.catalog = new CombinedModernCatalog(entry, logger, (method, params) =>
      this.askEach(method, params),
    )
  }

  async start(): Promise<void> {}

  hold(drained: Promise<void> | undefined): void {
    this.current?.hold(drained)
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('The request is closed')
    const work = this.handle(message)
      .catch((error: Error) => this.fail(error))
      .finally(() => this.working.delete(work))
    this.working.add(work)
  }

  async finish(): Promise<void> {
    await Promise.all(this.working)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
    await Promise.all(
      [...this.open].map((child) => {
        detach(child)
        return child.close()
      }),
    )
  }

  private fail(error: Error) {
    if (this.closed) return
    this.logger.error(`${this.entry.name}: request failed:`, error)
    this.onerror?.(error)
    void this.close()
  }

  private async handle(message: JSONRPCMessage) {
    if (!('method' in message)) return
    if (!('id' in message)) return this.notify(message)
    const request = message as Request
    try {
      const result = await this.answer(request)
      if (result !== undefined)
        this.onmessage?.({ jsonrpc: '2.0', id: request.id, result })
    } catch (err) {
      // What the gateway refuses is an answer; anything else failed.
      if (!(err instanceof RpcError)) throw err
      const { code, message: text, data } = err
      this.onmessage?.({
        jsonrpc: '2.0',
        id: request.id,
        error: { code, message: text, ...(data === undefined ? {} : { data }) },
      })
    }
  }

  // The result that answers a request; nothing when a server will.
  private async answer(request: Request): Promise<Params | undefined> {
    const { method, params } = request
    if (method === 'server/discover') return this.catalog.discover(request)
    if (isList(method)) return this.catalog.list(method, params)
    // A retry of a multi-round call: the server that has its state.
    if (this.current) {
      await this.current.send(request as JSONRPCMessage)
      return undefined
    }
    const { member, own } = await this.catalog.target(method, params)
    await this.passTo(
      member,
      method in NAMED
        ? { ...request, params: { ...params, name: own } }
        : request,
    )
  }

  // A server started for this request. It is stopped with the request.
  private started(member: ModernMember) {
    // A combined entry is only served when every server has one.
    const child = member.child!(this.request)
    this.open.add(child)
    return child.start().then(() => child)
  }

  // The server that answers the client itself: what it says is the client's.
  private async passTo(member: ModernMember, request: Request) {
    const child = await this.started(member)
    this.current = child
    child.onmessage = (message) => this.onmessage?.(message)
    child.onerror = (error) => this.fail(error)
    child.onclose = () =>
      this.fail(new Error(`Server "${member.name}" stopped`))
    await child.send(request as JSONRPCMessage)
  }

  // A notification has no server of its own: every server gets it.
  private async notify(message: JSONRPCMessage) {
    await Promise.all(
      this.entry.members.map(async (member) => {
        const child = await this.started(member)
        await child.send(message)
        await child.finish()
      }),
    )
  }

  // One request of the gateway's own to each server, each started for it.
  private askEach(method: string, params: Params | undefined) {
    return Promise.all(
      this.entry.members.map(async (member) => {
        const child = await this.started(member)
        return {
          member,
          ask: (cursor?: string) =>
            ask(child, {
              jsonrpc: '2.0',
              id: `supergateway-${++this.asks}`,
              method,
              params: cursor === undefined ? params : { ...params, cursor },
            }),
        }
      }),
    )
  }
}
