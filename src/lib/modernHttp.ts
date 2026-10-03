import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import {
  HeaderMismatch,
  validateModernHeaders,
  validateToolHeaders,
  findToolSchema,
  type ReadHeader,
} from './modernHeaders.js'
import {
  PerRequestHTTPServerTransport,
  classifyInboundRequest,
  toNodeHandler,
  isJsonContentType,
  type JSONRPCMessage,
  type JSONRPCResponse,
} from './modernSdk.js'
import type { Logger } from '../types.js'
import type { OwnedChildProcesses } from './ownedChildProcesses.js'
import { OwnedStdioTransport } from './ownedStdioTransport.js'
import { drained } from './outputBackpressure.js'
import {
  CONTINUATION_TIMEOUT,
  RETAINED_CHILD_LIMIT,
  RetainedChildren,
  isContinuationHandle,
} from './retainedChildren.js'
import type { ChildCommand } from './childCommand.js'

export function createModernHttp(args: {
  stdioCmd: ChildCommand
  children: OwnedChildProcesses
  logger: Logger
}) {
  const { stdioCmd, children, logger } = args
  const active = new Set<() => Promise<void>>()
  const retained = new RetainedChildren({
    idleMs: CONTINUATION_TIMEOUT,
    limit: RETAINED_CHILD_LIMIT,
    logger,
  })
  return {
    async close() {
      const closing = retained.close()
      await Promise.all([...active].map((stop) => stop()))
      await closing
    },
    async handle(req: Request, res: Response): Promise<boolean> {
      const value = headerValue(req)
      const route = admit(req, res, value)
      if (typeof route === 'boolean') return route
      const transport = new PerRequestHTTPServerTransport({
        classification: route.classification,
      })
      const continuation =
        route.messageKind === 'request'
          ? route.message.params!.requestState
          : undefined
      let reused: Reused
      if (isContinuationHandle(continuation)) {
        const client = whileConnected(res)
        reused = await retained.take(continuation, client.signal)
        client.done()
        if (!reused) {
          await transport.close()
          if (!res.destroyed)
            rejectWith(req, res, 400, {
              code: -32602,
              message: 'Continuation expired or backend unavailable',
            })
          return true
        }
      }
      return new ModernRequest({
        req,
        res,
        route,
        value,
        transport,
        reused,
        child:
          reused?.child ?? new OwnedStdioTransport(stdioCmd, children, logger),
        retained,
        active,
        children,
        logger,
      }).serve()
    },
  }
}

type Route = Exclude<ReturnType<typeof admit>, boolean>
type Reused = Awaited<ReturnType<RetainedChildren['take']>>

// A signal that aborts if the client goes away, until `done`.
const whileConnected = (res: Response) => {
  const waiting = new AbortController()
  const cancelled = () => waiting.abort()
  res.once('close', cancelled)
  if (res.destroyed) waiting.abort()
  return {
    signal: waiting.signal,
    done: () => res.off('close', cancelled),
  }
}

// A continuation's message carries the server's own request state again, in
// place of the gateway's handle, or none if the server minted none.
const restoredState = (
  message: Route['message'],
  reused: Reused,
): Route['message'] => {
  if (!reused) return message
  const restored: Route['message'] = {
    ...message,
    params: { ...message.params },
  }
  delete restored.params!.requestState
  if (reused.state !== undefined) restored.params!.requestState = reused.state
  return restored
}

const PROCESS_FAILED = { code: -32603, message: 'MCP server process failed' }

/**
 * A request the gateway itself makes of a request's child, whose reply is
 * taken out of the client's stream. While it waits, nothing else the child
 * says reaches the client.
 */
class ChildQuery {
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
    child: OwnedStdioTransport,
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

/**
 * One modern (2026-07-28) request: its transport, its child (new, or retained
 * from an earlier request that returned `input_required`), and everything that
 * passes between them until the request ends.
 */
class ModernRequest {
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
      child: OwnedStdioTransport
      retained: RetainedChildren
      active: Set<() => Promise<void>>
      children: OwnedChildProcesses
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
    if ('method' in message && 'id' in message) {
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
      if ('result' in message) message = this.withHandle(message)
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
    const { route, reused, child, children, value } = this.at
    if (this.stopped || children.closing)
      throw new Error('Gateway is shutting down')
    if (!reused) {
      await child.start()
      if (this.stopped) {
        // Cleanup ran before the process existed; release it now.
        await child.close()
        return
      }
    }
    const message = this.message
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
    // Once SSE headers are sent, errors must remain on that stream.
    return response.headers.get('content-type') === 'application/json' &&
      this.responseStatus !== response.status
      ? new globalThis.Response(response.body, {
          status: this.responseStatus,
          headers: response.headers,
        })
      : response
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

// A header as one string, however many times it was sent.
const headerValue =
  (req: Request): ReadHeader =>
  (name) => {
    const header = req.headers[name]
    return Array.isArray(header) ? header.join(', ') : header
  }

// The id a rejection answers: the request's own, when it has a usable one.
const requestIdOf = (body: unknown) => {
  const id = (body as { id?: unknown } | undefined)?.id
  return typeof id === 'string' || typeof id === 'number' ? id : null
}

const rejectWith = (
  req: Request,
  res: Response,
  status: number,
  error: { code: number; message: string; data?: unknown },
) => {
  res.status(status).json({
    jsonrpc: '2.0',
    id: requestIdOf(req.body),
    error,
  })
}

// The tool call's _meta for the gateway's own tools/list: the call's progress
// token names the client's request, which this is not.
const withoutProgressToken = (
  callMeta: Record<string, unknown> | undefined,
) => {
  const meta: Record<string, unknown> = { ...callMeta }
  delete meta.progressToken
  return meta
}

/**
 * Whether this POST is a modern request this gateway serves. `false` hands it
 * to the legacy path, `true` means it has been answered with a rejection, and
 * a route means serve it.
 */
function admit(req: Request, res: Response, value: ReadHeader) {
  const reject = (
    status: number,
    error: Parameters<typeof rejectWith>[3],
  ): true => {
    rejectWith(req, res, status, error)
    return true
  }
  const route = classifyInboundRequest({
    httpMethod: req.method,
    body: req.body,
    protocolVersionHeader: value('mcp-protocol-version'),
    mcpMethodHeader: value('mcp-method'),
    mcpNameHeader: value('mcp-name'),
  })
  if (route.kind === 'legacy') return false
  if (!isJsonContentType(value('content-type') ?? null))
    return reject(415, {
      code: -32000,
      message: 'Content-Type must be application/json',
    })
  if (route.kind === 'reject')
    return reject(route.httpStatus, {
      code: route.code,
      message: route.message,
      ...(route.data === undefined ? {} : { data: route.data }),
    })
  const accept = value('accept') ?? ''
  if (
    !accept.includes('application/json') ||
    !accept.includes('text/event-stream')
  )
    return reject(406, {
      code: -32000,
      message: 'Client must accept application/json and text/event-stream',
    })
  try {
    validateModernHeaders(route.message, value)
  } catch (error) {
    return reject(400, { code: -32020, message: (error as Error).message })
  }
  return route
}

// The HTTP status of a JSON reply carrying this error: an unknown method is a
// 404, a header mismatch a 400, and any other error rides a 200.
const statusForError = (code: number) =>
  code === -32601 ? 404 : [-32020, -32021, -32022].includes(code) ? 400 : 200

function mintedState(
  result: Record<string, unknown>,
): { value: string | undefined } | undefined {
  const { resultType, requestState } = result as Record<string, unknown>
  return resultType === 'input_required' &&
    (requestState === undefined || typeof requestState === 'string')
    ? { value: requestState as string | undefined }
    : undefined
}
