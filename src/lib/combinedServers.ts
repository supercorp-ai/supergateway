import type { Logger } from '../types.js'
import type { ChildOwner } from './childHandoff.js'
import { Backend, type CombinedMember } from './combinedBackend.js'
import {
  INTERNAL_ERROR,
  RpcError,
  isObject,
  type Params,
} from './combinedRules.js'

/**
 * The servers of one combined session: started when the session is, asked
 * what they speak, and left out when one fails to say, cannot speak what the
 * others do, or stops.
 */
export class CombinedServers {
  private backends: Backend[] = []

  constructor(
    private readonly entry: string,
    private readonly members: CombinedMember[],
    private readonly logger: Logger,
    /** What a server started for the session reports to. */
    private readonly ownerOf: (backend: Backend) => ChildOwner,
  ) {}

  /** Whether the servers were started, whatever became of them. */
  get wereStarted() {
    return this.backends.length > 0
  }

  /** Every server of the entry, started. */
  startAll() {
    this.backends = this.members.map((member) => this.start(member))
  }

  /** Each asked what it speaks; one that does not say is left out. */
  handshakeAll(params: Params | undefined) {
    return Promise.all(
      this.backends.map((backend) => this.handshake(backend, params)),
    )
  }

  /** The lowest version any of them answered. */
  lowestVersion() {
    // Dates, so the lowest sorts first.
    const [version] = this.started()
      .map((backend) => backend.version)
      .sort()
    return version
  }

  /** Those that answered another version, started again at `version`. */
  restartOthersAt(version: string, params: Params | undefined) {
    return Promise.all(
      this.live()
        .filter((backend) => backend.version !== version)
        .map((backend) => this.restartAt(backend, version, params)),
    )
  }

  /** Every server stopped, and none of them heard from again. */
  stopAll() {
    return Promise.all(
      this.backends.map((backend) => {
        backend.gone = true
        return backend.peer.stop()
      }),
    )
  }

  private start(member: CombinedMember) {
    const backend = new Backend(member)
    backend.peer = member.start()(this.ownerOf(backend))
    return backend
  }

  /** Those still there. */
  live() {
    return this.backends.filter((backend) => !backend.gone)
  }

  // The servers that are there; without any, there is no session.
  started() {
    const live = this.live()
    if (live.length === 0)
      throw new RpcError(INTERNAL_ERROR, `No server of "${this.entry}" started`)
    return live
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
}
