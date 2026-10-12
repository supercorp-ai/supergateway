import { ChildLink, type StartPeer } from '../lib/childHandoff.js'
import { StatelessInitialization } from '../lib/statelessInitialization.js'
import { type ServerSource, startServer } from '../lib/serverSource.js'
import type { OwnedChildProcesses } from '../lib/ownedChildProcesses.js'
import type { Logger } from '../types.js'
import type express from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { getVersion } from '../lib/getVersion.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { spawn } from 'child_process'
import { drained } from '../lib/outputBackpressure.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { failPendingCalls } from '../lib/failPendingCalls.js'

// How long a server sent only notifications has to read them and exit by
// itself, once its input has ended, before it is stopped.
const ONE_WAY_GRACE_MS = 5000

/**
 * One stateless POST: a server, transport and child of its own, released once
 * the response is over and the child owes it nothing.
 */
export class StatelessRequest {
  private readonly link: ChildLink
  private readonly initialization: StatelessInitialization
  private readonly pendingRequests = new Set<string | number>()
  private childFailed = false
  private released = false
  private finishTimer: NodeJS.Timeout | undefined
  private responseClosed = false
  private handled = false
  private hasOneWayMessage = false
  // Settles once the SDK has dispatched this request, and written any
  // reply of its own (a 400 for a request it refused).
  private dispatched!: () => void
  private readonly handling = new Promise<void>(
    (resolve) => (this.dispatched = resolve),
  )

  /** Serves one POST with a server, transport and child of its own. */
  static async serve(
    source: ServerSource,
    children: OwnedChildProcesses,
    logger: Logger,
    protocolVersion: string,
    req: express.Request,
    res: express.Response,
  ) {
    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    })
    await server.connect(transport)
    const peer = startServer(spawn, source, children, logger, 'Request')
    await new StatelessRequest(
      server,
      transport,
      peer,
      logger,
      protocolVersion,
      req,
      res,
    ).handle()
  }

  private constructor(
    private readonly server: Server,
    private readonly transport: StreamableHTTPServerTransport,
    peer: StartPeer,
    private readonly logger: Logger,
    private readonly protocolVersion: string,
    private readonly req: express.Request,
    private readonly res: express.Response,
  ) {
    res.once('close', () => {
      this.responseClosed = true
      this.finish()
    })

    this.link = new ChildLink(peer, {
      failure: (_kind, err) => this.fail(err),
      exit: (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        // HTTP EOF alone does not settle an SDK request. Use the same
        // idempotent error delivery as spawn/stdin failure before closing.
        this.fail()
      },
      message: (jsonMsg, line) => this.fromChild(jsonMsg, line),
      nonJson: (line) => logger.error(`Child non-JSON: ${line}`),
      stderr: (text) => logger.error(`Child stderr: ${text}`),
      output: () => drained([res]),
    })

    this.initialization = new StatelessInitialization(
      (message) => this.link.write(message),
      logger,
      () => this.finish(),
    )

    transport.onmessage = (msg: JSONRPCMessage) => this.fromClient(msg)

    transport.onclose = () => {
      logger.info('StreamableHttp connection closed')
      void this.stop()
    }

    transport.onerror = (err) => {
      logger.error(`StreamableHttp error:`, err)
      void this.stop()
    }
  }

  private async handle() {
    try {
      await this.transport.handleRequest(this.req, this.res, this.req.body)
    } catch (error) {
      this.release()
      throw error
    } finally {
      this.handled = true
      this.dispatched()
      this.finish()
    }
  }

  private stop() {
    return this.link.stop()
  }

  private fromClient(msg: JSONRPCMessage) {
    if ('id' in msg && 'method' in msg) this.pendingRequests.add(msg.id!)
    else this.hasOneWayMessage = true
    this.initialization.fromClient(
      msg,
      (this.req.headers['mcp-protocol-version'] as string | undefined) ??
        this.protocolVersion,
    )
  }

  private fromChild(jsonMsg: any, line: string) {
    this.logger.info('Child → StreamableHttp:', line)
    // A later HTTP POST starts a different child, so it cannot answer
    // this child's reverse request. Reply locally instead of hanging.
    if ('method' in jsonMsg && 'id' in jsonMsg) {
      this.link.write({
        jsonrpc: '2.0',
        id: jsonMsg.id,
        ...(jsonMsg.method === 'ping'
          ? { result: {} }
          : {
              error: {
                code: -32601,
                message:
                  'Server-to-client requests are not supported in stateless mode',
              },
            }),
      })
      return
    }
    if ('id' in jsonMsg) {
      this.pendingRequests.delete(jsonMsg.id)
    }

    // The answer to the gateway's own initialize is not the client's.
    if (this.initialization.fromChild(jsonMsg)) return

    void this.transport
      .send(jsonMsg, {
        // Each stateless child serves one POST. Responses route by
        // their own ID; notifications share the pending request stream.
        relatedRequestId: this.pendingRequests.values().next().value,
      })
      .catch((e) => {
        this.logger.error(`Failed to send to StreamableHttp`, e)
      })
      .finally(() => this.finish())
  }

  // Exit, ChildProcess errors and stdin errors can arrive for the same
  // child. Keep listeners installed and terminate this transport once.
  private fail(err?: Error) {
    if (this.childFailed) return
    this.childFailed = true
    this.released = true
    clearTimeout(this.finishTimer)
    if (err) this.logger.error('Child process failure:', err)
    void this.stop()
    const fail = () =>
      failPendingCalls({
        transport: this.transport,
        pending: this.pendingRequests,
        res: this.res,
        logger: this.logger,
      })
    // With calls pending, answer them now: the SDK's dispatch waits for
    // them. With none, the SDK may still be writing a reply of its own (a
    // 400 for a request it refused), which closing the transport and the
    // response would cut off; a server that ends at once (a remote
    // session, closed as soon as it is stopped) always did.
    if (this.pendingRequests.size) fail()
    else void this.handling.then(fail)
  }

  private release() {
    if (this.released) return
    this.released = true
    void this.stop()
    this.server.close().catch((error) => {
      this.logger.error('Failed to close completed stateless request', error)
    })
  }

  // Whether the request is over and its child owes it nothing, so the child
  // can go. handleRequest resolves after dispatch, not after the child
  // replies, and a disconnected HTTP client does not cancel its in-flight
  // work, so both are waited for.
  private get settled() {
    return (
      !this.released &&
      !this.finishTimer &&
      this.handled &&
      this.responseClosed &&
      !this.pendingRequests.size &&
      !this.initialization.pending
    )
  }

  private finish() {
    if (!this.settled) return
    if (this.hasOneWayMessage) {
      // HTTP 202 precedes delivery, and notifications have no completion
      // reply. Forward first, then allow stdio EOF a bounded grace period.
      this.link.peer.end()
      this.finishTimer = setTimeout(() => this.release(), ONE_WAY_GRACE_MS)
    } else this.release()
  }
}
