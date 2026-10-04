import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../types.js'
import type { ChildOwner, Peer, StartPeer } from './childHandoff.js'
import { getVersion } from './getVersion.js'
import {
  BY_URI,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  LISTS,
  LIST_CHANGED,
  METHOD_NOT_FOUND,
  NAMED,
  RESOURCE_NOT_FOUND,
  RpcError,
  isList,
  isObject,
  templateMatches,
  union,
  type ListMethod,
  type Params,
} from './combinedRules.js'

/** One of the servers combined on an entry's URL, started when a session is. */
export interface CombinedMember {
  name: string
  start: () => StartPeer
}

type Id = string | number
type Request = { jsonrpc: '2.0'; id: Id; method: string; params?: Params }
type Notification = { jsonrpc: '2.0'; method: string; params?: Params }

/** One combined server within a session: its peer and what it declared. */
class Backend {
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

/**
 * Several servers as one, for one session.
 *
 * Nothing is renamed: a tool, prompt or resource keeps its name, and the
 * request that names it goes to the server that has it. When two servers
 * offer the same name, the first listed in the config wins and the other's is
 * hidden, with a warning; `toolPrefix` on a server keeps both.
 *
 * - initialize goes to every server. The answer is the lowest protocol
 *   version among theirs (a server that answered a later one is started again
 *   at it), the union of their capabilities, and their instructions under
 *   their names. A server that fails to start is left out; the session fails
 *   only if all do.
 * - Lists are every server's, all pages, in config order, as one page.
 * - A request a server makes of the client (sampling, roots, elicitation)
 *   reaches the client under an id of the gateway's, and the answer goes back
 *   to that server under its own.
 * - A server that stops mid-session fails what it was asked and is left out;
 *   the session ends when the last one does.
 */
class Combined implements Peer {
  private backends: Backend[] = []
  /** Settles when initialize has been answered; unset before it arrives. */
  private ready: Promise<void> | undefined
  private readonly tables = new Map<ListMethod, Promise<Map<string, Backend>>>()
  /** The client's requests a server has yet to answer. */
  private readonly inFlight = new Map<Id, Backend>()
  /** The servers' requests the client has yet to answer, by the id it sees. */
  private readonly toBackend = new Map<
    string,
    { backend: Backend; id: Id; token?: string }
  >()
  /** Progress tokens of those requests, as the client sees them. */
  private readonly tokens = new Map<string, { backend: Backend; token: Id }>()
  private serverRequests = 0
  private ended = false
  /** Whether initialize has been answered: before it, nothing is announced. */
  private initialized = false

  constructor(
    private readonly entry: string,
    private readonly members: CombinedMember[],
    private readonly owner: ChildOwner,
    private readonly logger: Logger,
    /** The clashes already warned about, for every session of the entry. */
    private readonly warned: Set<string>,
  ) {}

  get gone() {
    return this.ended
  }

  write(message: JSONRPCMessage) {
    // A batch (2025-03-26) is taken message by message, and answered so.
    const items = Array.isArray(message) ? message : [message]
    for (const item of items as JSONRPCMessage[]) this.fromClient(item)
  }

  end() {
    for (const backend of this.live()) backend.peer.end()
  }

  async stop() {
    this.ended = true
    await Promise.all(
      this.backends.map((backend) => {
        backend.gone = true
        return backend.peer.stop()
      }),
    )
  }

  private live() {
    return this.backends.filter((backend) => !backend.gone)
  }

  private toClient(message: object, line = JSON.stringify(message)) {
    this.owner.message(message, line)
  }

  // --- From the client ---

  private fromClient(message: JSONRPCMessage) {
    if (!('method' in message)) this.clientResponse(message)
    else if ('id' in message) void this.request(message as Request)
    else this.clientNotification(message as Notification)
  }

  private async request(request: Request) {
    try {
      const result = await this.handle(request)
      if (result !== undefined)
        this.toClient({ jsonrpc: '2.0', id: request.id, result })
    } catch (err) {
      // Everything thrown on the way to an answer is an RpcError: what a
      // server fails at is caught where it is asked.
      const { code, message, data } = err as RpcError
      this.toClient({
        jsonrpc: '2.0',
        id: request.id,
        error: { code, message, ...(data === undefined ? {} : { data }) },
      })
      // With no server at all, the session is over, as it is for a server
      // alone that exits; the client has just been told why.
      if (this.backends.length > 0 && this.live().length === 0) this.finish()
    }
  }

  private finish(
    code: number | null = null,
    signal: NodeJS.Signals | null = null,
  ) {
    if (this.ended) return
    this.ended = true
    this.owner.exit(code, signal)
  }

  // The result that answers a request; nothing when a server will answer.
  private async handle(request: Request): Promise<Params | undefined> {
    const { method, params } = request
    if (method === 'initialize') return this.initialize(params)
    if (method === 'ping') return {}
    if (!this.ready)
      throw new RpcError(INVALID_REQUEST, 'The session is not initialized')
    await this.ready
    if (isList(method)) return this.list(method, params)
    if (method === 'logging/setLevel') return this.setLevel(params)
    this.forward(await this.target(method, params), request)
    return undefined
  }

  // The server a request is for: the one with the tool, prompt or resource
  // it names.
  private target(method: string, params: Params | undefined) {
    if (method in NAMED) return this.named(NAMED[method], params?.name)
    if (BY_URI.has(method)) return this.byUri(params?.uri)
    if (method === 'completion/complete')
      return params?.ref?.type === 'ref/prompt'
        ? this.named('prompts/list', params.ref.name)
        : this.byUri(params?.ref?.uri)
    throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`)
  }

  private forward(backend: Backend, request: Request) {
    this.inFlight.set(request.id, backend)
    backend.peer.write(request as JSONRPCMessage)
  }

  private clientNotification(notification: Notification) {
    const { method, params } = notification
    // The gateway has told each server itself.
    if (method === 'notifications/initialized') return
    if (method === 'notifications/cancelled') {
      this.inFlight
        .get(params?.requestId)
        ?.peer.write(notification as JSONRPCMessage)
      return
    }
    const progress =
      method === 'notifications/progress'
        ? this.tokens.get(params?.progressToken)
        : undefined
    if (progress) {
      progress.backend.peer.write({
        ...notification,
        params: { ...params, progressToken: progress.token },
      } as JSONRPCMessage)
      return
    }
    for (const backend of this.live())
      backend.peer.write(notification as JSONRPCMessage)
  }

  // The client's answer to a request a server made, under the server's id.
  private clientResponse(message: JSONRPCMessage & { id?: Id }) {
    const asked = this.toBackend.get(message.id as string)
    if (!asked) return
    this.forget(message.id as string)
    asked.backend.peer.write({ ...message, id: asked.id } as JSONRPCMessage)
  }

  private forget(clientId: string) {
    const asked = this.toBackend.get(clientId)!
    this.toBackend.delete(clientId)
    asked.backend.sent.delete(asked.id)
    if (asked.token !== undefined) this.tokens.delete(asked.token)
  }

  // --- initialize ---

  private async initialize(params: Params | undefined): Promise<Params> {
    if (this.ready)
      throw new RpcError(INVALID_REQUEST, 'The session is already initialized')
    let done!: () => void
    this.ready = new Promise((resolve) => (done = resolve))
    try {
      this.backends = this.members.map((member) => this.start(member))
      await Promise.all(
        this.backends.map((backend) => this.handshake(backend, params)),
      )
      // Dates, so the lowest sorts first.
      const [version] = this.started()
        .map((backend) => backend.version)
        .sort()
      await Promise.all(
        this.live()
          .filter((backend) => backend.version !== version)
          .map((backend) => this.restartAt(backend, version, params)),
      )
      // Again: one may have stopped while another was started again.
      for (const backend of this.started())
        backend.peer.write({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        })
      const instructions = this.live()
        .filter((backend) => backend.instructions)
        .map((backend) => `## ${backend.name}\n\n${backend.instructions}`)
        .join('\n\n')
      this.initialized = true
      return {
        protocolVersion: version,
        capabilities: this.live().reduce(
          (all, backend) => union(all, backend.capabilities),
          {},
        ),
        serverInfo: {
          name: 'supergateway',
          title: this.entry,
          version: getVersion(),
        },
        ...(instructions ? { instructions } : {}),
      }
    } finally {
      done()
    }
  }

  // The servers that are there; without any, there is no session.
  private started() {
    const live = this.live()
    if (live.length === 0)
      throw new RpcError(INTERNAL_ERROR, `No server of "${this.entry}" started`)
    return live
  }

  private start(member: CombinedMember) {
    const backend = new Backend(member)
    backend.peer = member.start()({
      message: (message, line) => this.fromBackend(backend, message, line),
      nonJson: (line) => this.owner.nonJson(`[${backend.name}] ${line}`),
      stderr: (text) => this.owner.stderr(`[${backend.name}] ${text}`),
      failure: (kind, err) =>
        this.lost(backend, `${kind} failure: ${err.message}`, null, null),
      exit: (code, signal) =>
        this.lost(
          backend,
          `it exited, code=${code}, signal=${signal}`,
          code,
          signal,
        ),
      output: () => this.owner.output(),
    })
    return backend
  }

  private async handshake(backend: Backend, params: Params | undefined) {
    try {
      const result = await backend.ask('initialize', params)
      backend.version = String(result.protocolVersion)
      backend.capabilities = isObject(result.capabilities)
        ? result.capabilities
        : {}
      // Not in 4.2: a task would outlive the request that routes it.
      delete backend.capabilities.tasks
      if (typeof result.instructions === 'string')
        backend.instructions = result.instructions
    } catch (err) {
      this.leaveOut(backend, (err as Error).message)
    }
  }

  // A server that answered a later version than another is started again and
  // asked for the one they all can speak; nothing is translated between them.
  private async restartAt(
    backend: Backend,
    version: string,
    params: Params | undefined,
  ) {
    backend.gone = true
    await backend.peer.stop()
    const again = this.start(backend.member)
    this.backends[this.backends.indexOf(backend)] = again
    await this.handshake(again, { ...params, protocolVersion: version })
    if (!again.gone && again.version !== version)
      this.leaveOut(
        again,
        `it speaks ${again.version}, and the others ${version}`,
      )
  }

  private leaveOut(backend: Backend, reason: string) {
    backend.gone = true
    this.logger.error(
      `${this.entry}: server "${backend.name}" is left out of this session: ${reason}`,
    )
    void backend.peer.stop()
  }

  // --- Lists and what they route ---

  private async list(method: ListMethod, params: Params | undefined) {
    // Every list is one page, so no cursor is the gateway's.
    if (params?.cursor !== undefined)
      throw new RpcError(INVALID_PARAMS, 'Invalid cursor')
    const { items } = await this.merged(method)
    return { [LISTS[method].key]: items }
  }

  private async merged(method: ListMethod) {
    const list = LISTS[method]
    const backends = this.live().filter(
      (backend) => list.capability in backend.capabilities,
    )
    const lists = await Promise.all(
      backends.map((backend) =>
        backend.listAll(method).catch((err: Error) => {
          this.logger.error(
            `${this.entry}: ${method} of server "${backend.name}" failed: ${err.message}`,
          )
          return []
        }),
      ),
    )
    const owners = new Map<string, Backend>()
    const items = lists.flatMap((listed, i) =>
      listed.filter((item) => {
        const id = (item as Params | null)?.[list.id]
        if (typeof id !== 'string') return true
        const first = owners.get(id)
        if (!first) {
          owners.set(id, backends[i])
          return true
        }
        this.warnOfClash(list.what, id, first, backends[i])
        return false
      }),
    )
    this.tables.set(method, Promise.resolve(owners))
    return { items, owners }
  }

  private warnOfClash(
    what: string,
    id: string,
    first: Backend,
    other: Backend,
  ) {
    const key = `${what} ${id}`
    if (this.warned.has(key)) return
    this.warned.add(key)
    this.logger.error(
      `${this.entry}: ${what} "${id}" is offered by "${first.name}" and "${other.name}"; clients get the one of "${first.name}", listed first${what === 'tool' ? '. Set "toolPrefix" on one of them to keep both' : ''}`,
    )
  }

  // Who has what, from the last list; fetched if there has been none, or
  // again when `fresh`.
  private table(method: ListMethod, fresh: boolean) {
    const known = fresh ? undefined : this.tables.get(method)
    if (known) return known
    const fetched = this.merged(method).then(({ owners }) => owners)
    this.tables.set(method, fetched)
    return fetched
  }

  // The server with the tool or prompt called `name`. A name the last list
  // did not have may be new, so the list is fetched once more before it is
  // refused.
  private async named(method: ListMethod, name: unknown): Promise<Backend> {
    for (const fresh of [false, true]) {
      const owner = (await this.table(method, fresh)).get(name as string)
      if (owner && !owner.gone) return owner
    }
    throw new RpcError(INVALID_PARAMS, `Unknown ${LISTS[method].what}: ${name}`)
  }

  // The server with the resource at `uri`: one that lists it, or one with a
  // template it fits.
  private async byUri(uri: unknown): Promise<Backend> {
    for (const fresh of [false, true]) {
      const listed = (await this.table('resources/list', fresh)).get(
        uri as string,
      )
      if (listed && !listed.gone) return listed
      const templates = await this.table('resources/templates/list', fresh)
      for (const [template, owner] of templates)
        if (
          !owner.gone &&
          (template === uri || templateMatches(template, String(uri)))
        )
          return owner
    }
    throw new RpcError(RESOURCE_NOT_FOUND, 'Resource not found', { uri })
  }

  private async setLevel(params: Params | undefined) {
    await Promise.all(
      this.live()
        .filter((backend) => 'logging' in backend.capabilities)
        .map((backend) =>
          backend
            .ask('logging/setLevel', params)
            .catch((err: Error) =>
              this.logger.error(
                `${this.entry}: logging/setLevel of server "${backend.name}" failed: ${err.message}`,
              ),
            ),
        ),
    )
    return {}
  }

  // --- From a server ---

  private fromBackend(backend: Backend, message: any, line: string) {
    if (backend.gone) return
    if (Array.isArray(message)) {
      for (const item of message)
        this.fromBackend(backend, item, JSON.stringify(item))
      return
    }
    if (!('method' in message)) this.backendResponse(backend, message, line)
    else if ('id' in message) this.backendRequest(backend, message)
    else this.backendNotification(backend, message, line)
  }

  private backendResponse(backend: Backend, message: any, line: string) {
    if (backend.settle(message)) return
    // An answer to nothing the client is waiting for from it is dropped.
    if (this.inFlight.get(message.id) !== backend) return
    this.inFlight.delete(message.id)
    this.toClient(message, line)
  }

  // A request a server makes of the client. Two servers number theirs alike,
  // so the client sees an id, and a progress token, of the gateway's.
  private backendRequest(backend: Backend, request: Request) {
    const n = ++this.serverRequests
    const id = `sgw:${backend.name}:${n}`
    const original = request.params?._meta?.progressToken
    const token =
      original === undefined ? undefined : `sgw:${backend.name}:${n}:progress`
    this.toBackend.set(id, { backend, id: request.id, token })
    backend.sent.set(request.id, id)
    if (token === undefined) {
      this.toClient({ ...request, id })
      return
    }
    this.tokens.set(token, { backend, token: original })
    this.toClient({
      ...request,
      id,
      params: {
        ...request.params,
        _meta: { ...request.params!._meta, progressToken: token },
      },
    })
  }

  private backendNotification(
    backend: Backend,
    notification: Notification,
    line: string,
  ) {
    const { method, params } = notification
    if (method === 'notifications/cancelled') {
      // Its own request, which the client knows under the gateway's id.
      const id = backend.sent.get(params?.requestId)
      if (id === undefined) return
      this.forget(id)
      this.toClient({ ...notification, params: { ...params, requestId: id } })
      return
    }
    if (method === 'notifications/message') {
      const logger = params?.logger
      this.toClient({
        ...notification,
        params: {
          ...params,
          logger: logger ? `${backend.name}/${logger}` : backend.name,
        },
      })
      return
    }
    // What it lists has changed, and so may who has what.
    if (LIST_CHANGED.test(method)) this.tables.clear()
    this.toClient(notification, line)
  }

  // A server that failed or exited. Before it answered initialize it is left
  // out; after, what it was asked fails, and the client is told its lists
  // changed. The session ends with the last server.
  private lost(
    backend: Backend,
    reason: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ) {
    if (backend.gone) return
    backend.abandon(reason)
    // Before it answered initialize, that rejection has just left it out.
    if (backend.version === '') return
    backend.gone = true
    this.logger.error(
      `${this.entry}: server "${backend.name}" stopped: ${reason}`,
    )
    for (const [id, target] of this.inFlight) {
      if (target !== backend) continue
      this.inFlight.delete(id)
      this.toClient({
        jsonrpc: '2.0',
        id,
        error: {
          code: INTERNAL_ERROR,
          message: `MCP server "${backend.name}" failed`,
        },
      })
    }
    for (const id of [...backend.sent.values()]) {
      this.forget(id)
      this.toClient({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: {
          requestId: id,
          reason: `MCP server "${backend.name}" failed`,
        },
      })
    }
    this.tables.clear()
    if (this.live().length === 0) {
      this.finish(code, signal)
      return
    }
    if (!this.initialized) return
    for (const kind of ['tools', 'prompts', 'resources'])
      if (kind in backend.capabilities)
        this.toClient({
          jsonrpc: '2.0',
          method: `notifications/${kind}/list_changed`,
        })
  }
}

/**
 * The servers of a combined entry as one peer. `warned` is the entry's, so a
 * clash is warned about once, not once a session.
 */
export const combinedPeer =
  (
    entry: string,
    members: CombinedMember[],
    logger: Logger,
    warned = new Set<string>(),
  ): StartPeer =>
  (owner) =>
    new Combined(entry, members, owner, logger, warned)
