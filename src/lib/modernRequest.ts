import type { Route } from './modernAdmission.js'
import { ChildQuery } from './childQuery.js'
import type { Request, Response } from 'express'
import {
  type ReadHeader,
  HeaderMismatch,
  findToolSchema,
  validateToolHeaders,
} from './modernHeaders.js'
import {
  type PerRequestHTTPServerTransport,
  type JSONRPCMessage,
  toNodeHandler,
} from './modernSdk.js'
import {
  type Reused,
  restoredState,
  PROCESS_FAILED,
  isRequest,
  statusForError,
  mintedState,
  withoutProgressToken,
  withStatus,
} from './modernRequestRules.js'
import type { ModernChild } from './upstreamModernChild.js'
import type { RetainedChildren } from './retainedChildren.js'
import type { OwnedChildProcesses } from './ownedChildProcesses.js'
import type { ToolNames } from './toolNames.js'
import type { Logger } from '../types.js'
import { drained } from './outputBackpressure.js'
export { type Reused } from './modernRequestRules.js'

/**
 * One modern (2026-07-28) request: its transport, its child (new, or retained
 * from an earlier request that returned `input_required`), and everything that
 * passes between them until the request ends.
 */
export class ModernRequest {
  private awaitingReply = false
  private readonly message: Route['message']
  private readonly query = new ChildQuery()
  private responseStatus = 200
  private dispatched: Promise<void> | undefined
  private failed = false
  private stopPromise: Promise<void> | undefined
  private readonly closed = () => {
    void this.stop()
  }

  constructor(
    private readonly at: {
      req: Request
      res: Response
      route: Route
      value: ReadHeader
      transport: PerRequestHTTPServerTransport
      reused: Reused
      child: ModernChild
      retained: RetainedChildren
      active: Set<() => Promise<void>>
      children: OwnedChildProcesses
      toolNames?: ToolNames
      logger: Logger
    },
  ) {
    const { route, reused, child, transport, logger } = at
    this.message = restoredState(route.message, reused)
    child.onerror = (error) => {
      void this.fail(error)
    }
    child.onclose = () => {
      void this.fail(new Error('Child stdout closed'))
    }
    child.onmessage = (message) => this.fromChild(message)
    transport.onerror = (error) =>
      logger.error('Modern HTTP transport error:', error)
    transport.onclose = () => {
      void this.stop()
    }
    transport.onmessage = () => {
      this.dispatched = this.dispatch().catch(this.fail)
    }
  }

  private get stopped(): boolean {
    return this.stopPromise !== undefined
  }

  // An arrow, so the gateway's set of active requests holds one identity.
  readonly stop = () => {
    const { res, logger } = this.at
    if (!this.stopPromise) {
      res.off('close', this.closed)
      this.query.cancel()
      this.stopPromise = Promise.resolve()
        .then(() => this.cleanUp())
        .catch((error) => {
          logger.error('Modern request cleanup failed:', error)
        })
    }
    return this.stopPromise
  }

  private async cleanUp() {
    const { transport, active } = this.at
    try {
      await transport.close()
    } finally {
      try {
        await this.handBackChild()
      } finally {
        active.delete(this.stop)
      }
    }
  }

  // A child whose reply asked for input stays for the retry, if the retained
  // children still name it; one that failed or never replied is stopped.
  private handBackChild() {
    const { retained, child } = this.at
    return !this.failed && !this.awaitingReply
      ? retained.release(child)
      : retained.discard(child)
  }

  private readonly fail = async (error: Error) => {
    const { route, transport, logger } = this.at
    if (this.stopped || this.failed) return
    this.failed = true
    logger.error('MCP child request failed:', error)
    const mismatch = error instanceof HeaderMismatch
    if (mismatch) this.responseStatus = 400
    if (route.messageKind === 'request') {
      await transport
        .send({
          jsonrpc: '2.0',
          id: route.message.id,
          error: mismatch
            ? { code: error.code, message: error.message }
            : PROCESS_FAILED,
        })
        .catch((error) => logger.error('Failed to send MCP error:', error))
    }
    await this.stop()
  }

  // Whether a message from the child is its reply to the client's request.
  private repliesToRequest(message: JSONRPCMessage) {
    const { route } = this.at
    return (
      'id' in message &&
      route.messageKind === 'request' &&
      message.id === route.message.id
    )
  }

  private fromChild(message: JSONRPCMessage) {
    const { route, transport, child, res } = this.at
    if (this.stopped) return
    if (isRequest(message)) {
      void this.fail(
        new Error('Unexpected server request on a modern connection'),
      )
      return
    }
    if (this.query.waiting) {
      this.query.receive(message)
      return
    }
    if (this.repliesToRequest(message)) {
      if ('error' in message)
        this.responseStatus = statusForError(message.error.code)
      this.awaitingReply = false
      if ('result' in message) message = this.withHandle(this.listed(message))
    }
    // The backend state is restored on retry; other payloads stay unchanged.
    // No protocol Client/Server is inserted to renegotiate or rewrite them.
    void transport
      .send(message, {
        relatedRequestId:
          route.messageKind === 'request' ? route.message.id : undefined,
      })
      .catch(this.fail)
    child.hold(drained([res]))
  }

  // The reply to a tools/list, as the client is to see it.
  private listed(message: Extract<JSONRPCMessage, { result: unknown }>) {
    const { toolNames } = this.at
    if (!toolNames || this.message.method !== 'tools/list') return message
    return { ...message, result: toolNames.listed(message.result) }
  }

  // A result asking for input keeps this request's child for the client's
  // retry, which names it by the handle given in place of the server's state.
  private withHandle(message: Extract<JSONRPCMessage, { result: unknown }>) {
    const { retained, child } = this.at
    const state = mintedState(message.result)
    if (!state) return message
    return {
      ...message,
      result: {
        ...message.result,
        requestState: retained.retain(state.value, child),
      },
    }
  }

  // One page of the child's tools, asked for on this request's child to find
  // a tool's schema; its reply is taken out of the client's stream.
  private async listToolsPage(
    callMeta: Record<string, unknown> | undefined,
    cursor: string | undefined,
  ) {
    if (this.stopped) throw new Error('Request closed')
    const result = await this.query.ask(this.at.child, 'tools/list', {
      _meta: withoutProgressToken(callMeta),
      ...(cursor === undefined ? {} : { cursor }),
    })
    if ('error' in result)
      throw new Error(`tools/list failed: ${result.error.message}`)
    return result.result
  }

  // What the transport's one message sets off: start the child, check a tool
  // call's headers against its schema, and pass the message on.
  private async dispatch() {
    const { route, reused, child, children, value, toolNames, transport } =
      this.at
    if (this.stopped || children.closing)
      throw new Error('Gateway is shutting down')
    // A call to a tool the client can't see is answered here, before any
    // server starts; any other call goes on under the server's own name.
    const sent = toolNames?.inbound(this.message) ?? { forward: this.message }
    if ('reply' in sent) {
      await transport.send(sent.reply, { relatedRequestId: sent.reply.id })
      return
    }
    if (!reused) {
      await child.start()
      if (this.stopped) {
        // Cleanup ran before the process existed; release it now.
        await child.close()
        return
      }
    }
    const message = sent.forward as Route['message']
    if (route.messageKind === 'request' && message.method === 'tools/call') {
      // Modern request envelopes are checked by the SDK classifier.
      const params = message.params!
      const schema = await findToolSchema(params.name, (cursor) =>
        this.listToolsPage(params._meta, cursor),
      )
      validateToolHeaders(schema, params.arguments, value)
    }
    if (this.stopped) return
    this.awaitingReply = route.messageKind === 'request'
    await child.send(message)
    if (route.messageKind === 'notification') await child.finish()
  }

  // The HTTP response for the request, from the SDK's transport.
  private async respond(request: globalThis.Request) {
    const { route, transport } = this.at
    const response = await transport.handleMessage(route.message, {
      request,
    })
    if (route.messageKind === 'notification') {
      await this.dispatched
      if (this.failed)
        return globalThis.Response.json(
          { jsonrpc: '2.0', id: null, error: PROCESS_FAILED },
          { status: 500 },
        )
    }
    return withStatus(response, this.responseStatus)
  }

  async serve(): Promise<boolean> {
    const { req, res, transport, active, logger } = this.at
    active.add(this.stop)
    // Node18 can lose a derived Web Request's AbortSignal linkage after GC.
    res.once('close', this.closed)
    if (res.destroyed) {
      await this.stop()
      return true
    }
    await transport.start()
    const handle = toNodeHandler(
      { fetch: (request) => this.respond(request) },
      {
        onerror: (error) => logger.error('Modern HTTP adapter error:', error),
      },
    )
    try {
      await handle(req, res, req.body)
    } finally {
      await this.stop()
    }
    return true
  }
}
