import type { Request, Response } from 'express'
import { randomUUID } from 'node:crypto'
import {
  HEADER_MISMATCH,
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
import type { ToolNames } from './toolNames.js'
import type { RemoteServer } from './upstreamPeer.js'
import type { ServerSource } from './serverSource.js'
import { UpstreamModernChild, type ModernChild } from './upstreamModernChild.js'

export function createModernHttp(
  args: {
    /** The tools a client sees of the server, if not all as they are. */
    toolNames?: ToolNames
    children: OwnedChildProcesses
    logger: Logger
  } & (
    | { stdioCmd: ChildCommand; upstream?: undefined }
    | { upstream: RemoteServer; stdioCmd?: undefined }
  ),
) {
  const { toolNames, children, logger } = args
  // The server one request is for: a process started for it, or the remote
  // server, told what the client's request declared.
  const childFor = (req: Request): ModernChild =>
    args.upstream
      ? new UpstreamModernChild(
          args.upstream,
          {
            version: headerValue(req)('mcp-protocol-version'),
            params: paramHeaders(req),
          },
          logger,
        )
      : new OwnedStdioTransport(args.stdioCmd, children, logger)
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
              code: INVALID_PARAMS,
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
        child: reused?.child ?? childFor(req),
        retained,
        active,
        children,
        toolNames,
        logger,
      }).serve()
    },
  }
}

/**
 * The 2026-07-28 relay for a gateway's server, if it can have one: a local
 * server is started for each request, and a remote Streamable HTTP server is
 * sent each. A remote SSE server has no such requests, and servers combined
 * answer the earlier protocol versions only; a client asking either for
 * 2026-07-28 is told it is not spoken, and falls back by itself.
 */
export function modernRelayFor(
  source: ServerSource,
  children: OwnedChildProcesses,
  logger: Logger,
) {
  const { toolNames } = source
  if (source.stdioCmd)
    return createModernHttp({
      stdioCmd: source.stdioCmd,
      toolNames,
      children,
      logger,
    })
  if (source.upstream?.type === 'streamableHttp')
    return createModernHttp({
      upstream: source.upstream,
      toolNames,
      children,
      logger,
    })
  return undefined
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

// The JSON-RPC error codes the relay answers with, or reads a status from.
const SERVER_ERROR = -32000
const METHOD_NOT_FOUND = -32601
const INVALID_PARAMS = -32602
const INTERNAL_ERROR = -32603
// The 2026-07-28 errors about the request's framing: a header that does not
// mirror the body, a missing client capability, an unsupported version.
const FRAMING_ERRORS = [HEADER_MISMATCH, -32021, -32022]

const PROCESS_FAILED = {
  code: INTERNAL_ERROR,
  message: 'MCP server process failed',
}

// The child asking something of the client, which a modern request cannot.
const isRequest = (message: JSONRPCMessage) =>
  'method' in message && 'id' in message

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
    child: ModernChild,
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

// A JSON response with the status its reply calls for. Once SSE headers are
// sent, errors must remain on that stream.
const withStatus = (response: globalThis.Response, status: number) =>
  response.headers.get('content-type') === 'application/json' &&
  status !== response.status
    ? new globalThis.Response(response.body, {
        status,
        headers: response.headers,
      })
    : response

// A header as one string, however many times it was sent.
const headerValue =
  (req: Request): ReadHeader =>
  (name) => {
    const header = req.headers[name]
    return Array.isArray(header) ? header.join(', ') : header
  }

// The client's mirrors of a tool call's arguments, as it sent them.
const paramHeaders = (req: Request) =>
  Object.fromEntries(
    Object.keys(req.headers)
      .filter((name) => name.startsWith('mcp-param-'))
      .map((name) => [name, headerValue(req)(name)!]),
  )

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
      code: SERVER_ERROR,
      message: 'Content-Type must be application/json',
    })
  if (route.kind === 'reject')
    return reject(route.httpStatus, {
      code: route.code,
      message: route.message,
      ...(route.data === undefined ? {} : { data: route.data }),
    })
  if (!acceptsBoth(value('accept') ?? ''))
    return reject(406, {
      code: SERVER_ERROR,
      message: 'Client must accept application/json and text/event-stream',
    })
  try {
    validateModernHeaders(route.message, value)
  } catch (error) {
    return reject(400, {
      code: HEADER_MISMATCH,
      message: (error as Error).message,
    })
  }
  return route
}

// A modern reply may be JSON or an SSE stream, so the client must take both.
const acceptsBoth = (accept: string) =>
  accept.includes('application/json') && accept.includes('text/event-stream')

// The HTTP status of a JSON reply carrying this error: an unknown method is a
// 404, a framing error a 400, and any other error rides a 200.
const statusForError = (code: number) =>
  code === METHOD_NOT_FOUND ? 404 : FRAMING_ERRORS.includes(code) ? 400 : 200

function mintedState(
  result: Record<string, unknown>,
): { value: string | undefined } | undefined {
  const { resultType, requestState } = result as Record<string, unknown>
  return resultType === 'input_required' &&
    (requestState === undefined || typeof requestState === 'string')
    ? { value: requestState as string | undefined }
    : undefined
}
