import type {
  ModernRequestInfo,
  ModernMember,
  CombinedModernEntry,
  Request,
} from './combinedModernTypes.js'
import type { ModernChild } from './upstreamModernChild.js'
import type { JSONRPCMessage } from './modernSdk.js'
import type { Logger } from '../types.js'
import {
  detach,
  ask,
  cacheHints,
  allPages,
  ownName,
} from './combinedModernAsk.js'
import {
  RpcError,
  type Params,
  isList,
  NAMED,
  INTERNAL_ERROR,
  union,
  isObject,
  type ListMethod,
  INVALID_PARAMS,
  LISTS,
  templateMatches,
  BY_URI,
  METHOD_NOT_FOUND,
  RESOURCE_NOT_FOUND,
} from './combinedRules.js'
import { getVersion } from './getVersion.js'
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

  constructor(
    private readonly entry: CombinedModernEntry,
    private readonly request: ModernRequestInfo,
    private readonly logger: Logger,
  ) {}

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
    if (method === 'server/discover') return this.discover(request)
    if (isList(method)) return this.list(method, params)
    // A retry of a multi-round call: the server that has its state.
    if (this.current) {
      await this.current.send(request as JSONRPCMessage)
      return undefined
    }
    const { member, own } = await this.target(method, params)
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

  private async discover(request: Request): Promise<Params> {
    const servers = await this.askEach(request.method, request.params)
    const answers = await Promise.all(servers.map(({ ask }) => ask()))
    const results = answers.map((answer, i) => {
      if (!answer.result)
        throw new RpcError(
          INTERNAL_ERROR,
          `Server "${servers[i].member.name}" failed: ${answer.error?.message}`,
        )
      return answer.result
    })
    const instructions = results
      .map((result, i) =>
        typeof result.instructions === 'string'
          ? `## ${servers[i].member.name}\n\n${result.instructions}`
          : '',
      )
      .filter(Boolean)
      .join('\n\n')
    const { instructions: _own, ...first } = results[0]
    return {
      ...first,
      supportedVersions: results
        .map((result) => result.supportedVersions as string[])
        .reduce((all, versions) => all.filter((v) => versions.includes(v))),
      capabilities: results.reduce(
        (all, result) =>
          union(all, isObject(result.capabilities) ? result.capabilities : {}),
        {},
      ),
      serverInfo: {
        name: 'supergateway',
        title: this.entry.name,
        version: getVersion(),
      },
      ...(instructions ? { instructions } : {}),
      ...cacheHints(results),
    }
  }

  private async list(method: ListMethod, params: Params | undefined) {
    // Every list is one page, so no cursor is the gateway's.
    if (params?.cursor !== undefined)
      throw new RpcError(INVALID_PARAMS, 'Invalid cursor')
    const list = LISTS[method]
    // The call's progress token names the client's request, not these.
    const { progressToken: _token, ..._meta } = params?._meta ?? {}
    const servers = await this.askEach(method, { ...params, _meta })
    const pages = await Promise.all(
      servers.map((server) =>
        // A server whose list fails is left out of it; the others' stand.
        allPages(server).catch((err: Error) => {
          this.logger.error(
            `${this.entry.name}: ${method} of server "${server.member.name}" failed: ${err.message}`,
          )
          return []
        }),
      ),
    )
    const owners = new Map<string, { member: ModernMember; own: string }>()
    const items = pages.flatMap((results, i) => {
      const { member } = servers[i]
      const own = results.flatMap((result) =>
        Array.isArray(result[list.key]) ? (result[list.key] as unknown[]) : [],
      )
      // A server's own tool settings, as its sessions see them.
      const shown =
        method === 'tools/list' && member.toolNames
          ? (member.toolNames.listed({ tools: own }).tools as unknown[])
          : own
      return shown.filter((item) => {
        const id = (item as Params | null)?.[list.id]
        if (typeof id !== 'string') return true
        const first = owners.get(id)
        if (!first) {
          owners.set(id, { member, own: ownName(member, method, id) })
          return true
        }
        this.warnOfClash(list.what, id, first.member, member)
        return false
      })
    })
    this.entry.tables.set(method, owners)
    const all = pages.flat()
    const { nextCursor: _cursor, [list.key]: _items, ...first } = all[0] ?? {}
    return { ...first, [list.key]: items, ...cacheHints(all) }
  }

  private warnOfClash(
    what: string,
    id: string,
    first: ModernMember,
    other: ModernMember,
  ) {
    const key = `${what} ${id}`
    if (this.entry.warned.has(key)) return
    this.entry.warned.add(key)
    this.logger.error(
      `${this.entry.name}: ${what} "${id}" is offered by "${first.name}" and "${other.name}"; clients get the one of "${first.name}", listed first${what === 'tool' ? '. Set "toolPrefix" on one of them to keep both' : ''}`,
    )
  }

  // Who has what a request names: from the entry's table, or from a list
  // fetched when the table does not have it; the name may be new.
  private async owner(method: ListMethod, id: unknown, meta: unknown) {
    const known = this.entry.tables.get(method)?.get(id as string)
    if (known) return known
    await this.list(method, { _meta: meta })
    return this.entry.tables.get(method)!.get(id as string)
  }

  // The server with a template `uri` fits, by the same two looks.
  private async templateOwner(uri: unknown, meta: unknown) {
    const fits = () =>
      [...(this.entry.tables.get('resources/templates/list') ?? [])].find(
        ([template]) =>
          template === uri || templateMatches(template, String(uri)),
      )?.[1]
    const known = fits()
    if (known) return known
    await this.list('resources/templates/list', { _meta: meta })
    return fits()
  }

  // The server a request is for: the one with the tool, prompt or resource
  // it names.
  private async target(method: string, params: Params | undefined) {
    const meta = params?._meta
    const completes = method === 'completion/complete'
    const named: [ListMethod, unknown] | undefined =
      completes && params?.ref?.type === 'ref/prompt'
        ? ['prompts/list', params.ref.name]
        : method in NAMED
          ? [NAMED[method], params?.name]
          : undefined
    if (named) {
      const owner = await this.owner(named[0], named[1], meta)
      if (owner) return owner
      throw new RpcError(
        INVALID_PARAMS,
        `Unknown ${LISTS[named[0]].what}: ${named[1]}`,
      )
    }
    if (!completes && !BY_URI.has(method))
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
    const uri = completes ? params?.ref?.uri : params?.uri
    const owner =
      (await this.owner('resources/list', uri, meta)) ??
      (await this.templateOwner(uri, meta))
    if (owner) return owner
    throw new RpcError(RESOURCE_NOT_FOUND, 'Resource not found', { uri })
  }
}
