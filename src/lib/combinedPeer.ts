import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../types.js'
import type { ChildOwner, Peer, StartPeer } from './childHandoff.js'
import {
  Backend,
  type CombinedMember,
  type Id,
  type Request,
} from './combinedBackend.js'
import { CombinedCatalog } from './combinedCatalog.js'
import { ServerRequests } from './combinedServerRequests.js'
import { getVersion } from './getVersion.js'
import {
  INTERNAL_ERROR,
  INVALID_REQUEST,
  LIST_CHANGED,
  RpcError,
  isList,
  isObject,
  union,
  type Params,
} from './combinedRules.js'

type Notification = { jsonrpc: '2.0'; method: string; params?: Params }

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
  /** Who has what, as the last lists said. */
  private readonly catalog: CombinedCatalog
  /** Settles when initialize has been answered; unset before it arrives. */
  private ready: Promise<void> | undefined
  /** The client's requests a server has yet to answer. */
  private readonly inFlight = new Map<Id, Backend>()
  /** The servers' requests the client has yet to answer. */
  private readonly serverRequests = new ServerRequests()
  private ended = false
  /** Whether initialize has been answered: before it, nothing is announced. */
  private initialized = false

  constructor(
    private readonly entry: string,
    private readonly members: CombinedMember[],
    private readonly owner: ChildOwner,
    private readonly logger: Logger,
    /** The clashes already warned about, for every session of the entry. */
    warned: Set<string>,
  ) {
    this.catalog = new CombinedCatalog(entry, logger, warned, () => this.live())
  }

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
    if (isList(method)) return this.catalog.list(method, params)
    if (method === 'logging/setLevel') return this.setLevel(params)
    this.forward(await this.catalog.target(method, params), request)
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
        ? this.serverRequests.progress(params?.progressToken)
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
    const asked = this.serverRequests.answered(message.id as string)
    if (!asked) return
    asked.backend.peer.write({ ...message, id: asked.id } as JSONRPCMessage)
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
    this.toClient(this.serverRequests.add(backend, request))
  }

  private backendNotification(
    backend: Backend,
    notification: Notification,
    line: string,
  ) {
    const { method, params } = notification
    if (method === 'notifications/cancelled') {
      // Its own request, which the client knows under the gateway's id.
      const id = this.serverRequests.cancelled(backend, params?.requestId)
      if (id === undefined) return
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
    if (LIST_CHANGED.test(method)) this.catalog.forget()
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
    for (const id of this.serverRequests.abandoned(backend))
      this.toClient({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: {
          requestId: id,
          reason: `MCP server "${backend.name}" failed`,
        },
      })
    this.catalog.forget()
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
