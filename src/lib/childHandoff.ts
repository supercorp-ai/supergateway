import { type ChildLink, isHandshake, isResponseTo } from './childLink.js'
import type { ChildOwner } from './peer.js'
import type { Logger } from '../types.js'
import { WaitingChild } from './waitingChild.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

export { ChildLink, isHandshake } from './childLink.js'

export {
  type ChildOwner,
  type Peer,
  type StartPeer,
  processPeer,
} from './peer.js'

// How long a child whose client gave up during initialize waits for a retry.
export const HANDOFF_WINDOW_MS = 30000

// Initialize params compared regardless of key order.
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : inner,
  )

// The owner of a child taken over by another client: the child's answer to the
// initialize it received carries the new client's request id.
const renumbered = (
  owner: ChildOwner,
  from: string | number,
  to: string | number,
): ChildOwner => {
  let answered = false
  return {
    ...owner,
    message: (message, line) => {
      if (!answered && isResponseTo(message, from)) {
        answered = true
        message = { ...message, id: to }
        line = JSON.stringify(message)
      }
      owner.message(message, line)
    },
  }
}

// The owner of a child nobody will use: only its exit is worth a line.
const unusedOwner = (logger: Logger, label: string): ChildOwner => ({
  message: () => {},
  nonJson: () => {},
  stderr: () => {},
  failure: () => {},
  exit: (code, signal) =>
    logger.info(
      `${label}: unused server stopped, code=${code}, signal=${signal}`,
    ),
  output: () => undefined,
})

/**
 * Children whose clients gave up while they were still starting (GW-035).
 *
 * Since 4.1.0 every SSE and WebSocket connection starts its own child. A
 * client whose initialize times out before a slow server has started (5 s in
 * pydantic-ai) used to succeed on its retry, because the one shared child was
 * up by then; with a child per connection every retry started from cold and
 * failed the same way.
 *
 * So a child whose client sent nothing but initialize, and left before it was
 * answered, is not stopped at once. For a short window, the next client whose
 * first message is an identical initialize takes it over, and receives the
 * answer as its own. That child has received one message, the same one the new
 * client sent, and the gateway gives a child nothing else from its client (no
 * headers, no environment), so it is indistinguishable from one started for the
 * new client. No child is started that would not have been, and none earlier:
 * the only difference is that an abandoned child lives up to the window
 * longer. One that nobody takes is stopped as before.
 */
export class ChildHandoff {
  private readonly parked = new Map<string, WaitingChild[]>()

  constructor(
    private readonly logger: Logger,
    private readonly windowMs = HANDOFF_WINDOW_MS,
  ) {}

  /**
   * End a client's hold on its child: park it if it can be handed on, stop it
   * otherwise. `onlyInitialize` says the client sent nothing but initialize.
   */
  release(link: ChildLink, onlyInitialize: boolean, label: string) {
    if (!onlyInitialize || !link.initializing) {
      void link.stop()
      return
    }
    const key = canonical(link.initialize!.params)
    const waiting: WaitingChild = new WaitingChild(
      link,
      label,
      this.logger,
      this.windowMs,
      () => this.remove(key, waiting),
    )
    link.owner = waiting
    this.parked.set(key, [...(this.parked.get(key) ?? []), waiting])
    this.logger.info(
      `${label}: client left before its initialize was answered; keeping the server ${this.windowMs} ms for a retry`,
    )
  }

  /**
   * The waiting child for this initialize, if there is one. The caller becomes
   * its owner: everything the child said while waiting is replayed to it, and
   * the answer to the original initialize carries the caller's request id.
   */
  adopt(
    message: JSONRPCMessage,
    owner: ChildOwner,
    label: string,
  ): ChildLink | undefined {
    if (!isHandshake(message)) return
    const waiting = this.parked.get(canonical(message.params))?.[0]
    if (!waiting) return
    waiting.settle()
    const { link } = waiting
    link.owner = renumbered(owner, link.initialize!.id, message.id)
    this.logger.info(
      `${label}: took over a server whose previous client left during an identical initialize`,
    )
    waiting.replay()
    return link
  }

  /** Stop a child nobody will use, without its ending reaching a session. */
  discard(link: ChildLink, label: string) {
    link.owner = unusedOwner(this.logger, label)
    void link.stop()
  }

  private remove(key: string, waiting: WaitingChild) {
    const rest = this.parked.get(key)!.filter((other) => other !== waiting)
    if (rest.length) this.parked.set(key, rest)
    else this.parked.delete(key)
  }
}
