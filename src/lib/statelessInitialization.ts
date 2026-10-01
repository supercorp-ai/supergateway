import {
  JSONRPCMessage,
  isInitializeRequest,
  isInitializedNotification,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import {
  createInitializeRequest,
  createInitializedNotification,
} from './childInitialization.js'

/**
 * The handshake of a stateless request's child. Stateless HTTP spawns a fresh
 * child for every POST, so the gateway initializes it itself before anything
 * but an initialize request reaches it, and holds what the POST carried until
 * the child has answered.
 *
 * Unlike a per-connection child (ChildInitialization), this one serves a
 * single request: the client's own initialize is forwarded with its
 * capabilities removed, since nothing can answer a server request on a later
 * POST, and the client's initialized notification is always dropped, since the
 * gateway sends its own.
 */
export class StatelessInitialization {
  // The initialize the child is answering, the gateway's or the client's.
  private initializeRequestId: string | number | null = null
  // Whether that initialize is the gateway's own.
  private autoInitializing = false
  // Everything a POST carried before the child finished initializing. A
  // JSON-RPC batch (protocol 2025-03-26) delivers several messages here.
  private readonly held: JSONRPCMessage[] = []

  constructor(
    private readonly write: (message: JSONRPCMessage) => void,
    private readonly logger: Logger,
    // Called once the gateway's own handshake is done, when the request may be
    // able to finish.
    private readonly initialized: () => void,
  ) {}

  /** Whether the gateway's own initialize is still unanswered. */
  get pending() {
    return this.autoInitializing
  }

  /**
   * A message the client posted. `protocolVersion` is the version the gateway
   * initializes the child with if the message is not an initialize request.
   */
  fromClient(msg: JSONRPCMessage, protocolVersion: string) {
    // This child is initialized by the gateway, which sends its own
    // notifications/initialized. The client's copy would be a second one, and
    // a server that sets up on initialized would do it twice. (The bridges
    // drop it for the same reason; see relayClientMessage.) One carrying an id
    // is a request, and is answered like any other.
    if (!('id' in msg) && isInitializedNotification(msg)) {
      this.logger.info('Client initialized; this child was initialized here')
      return
    }
    this.logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)

    // Auto-initialize anything that is not itself an initialize request.
    //
    // This used to also test an `isInitialized` flag, which could never be
    // true here. Stateless spawns a child per POST and declares its state
    // inside the request handler, so nothing has handshaken when a message
    // arrives; the flag was set from the child's stdout handler, which cannot
    // run before this one returns, because the SDK dispatches a POST's
    // messages in a synchronous `for` loop with no await between iterations.
    // The condition was dead, and the flag write-only with it.
    if (!isInitializeRequest(msg)) {
      this.held.push(msg)
      // The rest of a batch arrives while the first message's handshake is in
      // flight. One initialize serves them all; a second would replace the
      // first's tracking and strand its queued message.
      if (this.autoInitializing) return
      this.initializeRequestId = `init_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      this.autoInitializing = true

      this.logger.info(
        'Non-initialize message detected, sending auto-initialize request first',
      )
      // Every request after initialize names the version the client
      // negotiated (from 2025-06-18 on), and the SDK has already refused one it
      // does not support. Initialize this request's child with it, or the
      // server treats a current client as a 2024-11-05 one. --protocolVersion
      // is for clients that do not say.
      const initRequest = createInitializeRequest(
        this.initializeRequestId,
        protocolVersion,
      )
      this.logger.info(
        `StreamableHttp → Child (auto-initialize): ${JSON.stringify(initRequest)}`,
      )
      this.write(initRequest)
      return
    }

    // Only an initialize request reaches this line — everything else returned
    // above — so the predicate that used to lead this condition is implied by
    // control flow now.
    //
    // The id still has to be looked for: `isInitializeRequest` accepts a
    // notification-shaped initialize, because the SDK's schema requires only
    // `method` and `params`. Presence is the whole test. Every version in the
    // support matrix (1.18.2 through 1.30.0) parses a request with a strict
    // schema whose `id` is `union([string, number.int()])` and a notification
    // with a strict schema carrying no `id` key, so a present `id` is never
    // `undefined`.
    //
    // The assertion is for the compiler, not the value. `msg` is the message
    // union, and narrowing it with `in` leaves the notification-shaped member
    // in the type with `id?: undefined` bolted on — from SDK 1.25.3 the
    // declared type is therefore `string | number | undefined`, though the
    // runtime check has already excluded exactly that member.
    if ('id' in msg) {
      this.initializeRequestId = msg.id!
      this.autoInitializing = false // This is client-initiated
      this.logger.info(`Tracking initialize request ID: ${msg.id}`)
    }

    // This child cannot use client features that require another HTTP POST.
    this.write({
      ...msg,
      params: { ...msg.params, capabilities: {} },
    })
  }

  /**
   * A message from the child. Returns true for the answer to the gateway's own
   * initialize, which the client never asked for and must not receive.
   */
  fromChild(jsonMsg: { id?: unknown }): boolean {
    if (!this.initializeRequestId || jsonMsg.id !== this.initializeRequestId)
      return false
    this.logger.info('Initialize response received')
    // A client's own initialize: its answer goes to the client.
    if (!this.autoInitializing) {
      this.initializeRequestId = null
      return false
    }
    const initializedNotification = createInitializedNotification()
    this.logger.info(
      `StreamableHttp → Child (initialized): ${JSON.stringify(initializedNotification)}`,
    )
    this.write(initializedNotification)

    // Now send the original messages, in the order they arrived. There is
    // always at least one: auto-initializing only ever starts after holding a
    // message, which is why this is not a `for` loop with a zero-iteration
    // case nothing can reach.
    this.held.splice(0).forEach((original) => {
      this.logger.info(
        `StreamableHttp → Child (original): ${JSON.stringify(original)}`,
      )
      this.write(original)
    })

    this.autoInitializing = false
    this.initializeRequestId = null
    this.initialized()
    return true
  }
}
