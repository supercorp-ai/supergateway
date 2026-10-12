import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  type JSONRPCRequest,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { ReconnectSchedule } from './reconnectSchedule.js'
import type { Logger } from '../types.js'
import {
  type BridgeLifecycle,
  interceptRequests,
  upstreamClientIdentity,
} from '../lib/stdioBridge.js'
import { readAsDrained } from '../lib/outputBackpressure.js'
import { relayServerMessages } from '../lib/relayServerMessages.js'
import { rejectMalformedInitialize, upstreamLost } from './upstreamFailures.js'
import { z } from 'zod'
import { MAX_TIMEOUT_MS } from '../lib/longTimeout.js'
import { setTimeout as delay } from 'node:timers/promises'

// How long ending the upstream session may hold up the exit.
const END_SESSION_TIMEOUT_MS = 2000

/** One stdio request: the transport it was sent on, once it was. */
export interface Attempt {
  transport?: StreamableHTTPClientTransport
}

/** The SDK client and the transport it connected over, in use together. */
interface Connection {
  client: Client
  transport: StreamableHTTPClientTransport
}

/**
 * The bridge's connection to the upstream server, and its replacement after
 * the upstream is lost once a session has worked.
 */
export class Upstream {
  connection: Connection | undefined
  private initializeMessage: JSONRPCRequest | undefined
  private connecting: Promise<unknown> | undefined
  private readonly reconnects = new ReconnectSchedule()
  private hasConnected = false

  constructor(
    private readonly url: URL,
    private readonly headers: Record<string, string>,
    private readonly logger: Logger,
    private readonly exit: BridgeLifecycle['exit'],
  ) {}

  private isCurrent(transport: StreamableHTTPClientTransport) {
    return this.connection?.transport === transport
  }

  private invalidate(transport: StreamableHTTPClientTransport) {
    if (!this.isCurrent(transport)) return
    const stale = this.connection!.client
    this.connection = undefined
    void Promise.resolve()
      .then(() => stale.close())
      .catch((err) =>
        this.logger.error('Failed to close stale Streamable HTTP client:', err),
      )
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (!this.hasConnected) return
    this.reconnects.schedule(() => {
      void this.connect().catch((err) => {
        this.logger.error('Streamable HTTP reconnect failed:', err)
      })
    })
  }

  private openTransport() {
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: this.headers },
      // Read upstream responses only as fast as the stdio client reads.
      fetch: async (url, init) =>
        readAsDrained(await fetch(url, init), process.stdout),
    })
    relayServerMessages(transport, (message) => {
      this.logger.info('Streamable HTTP → Stdio:', message)
      process.stdout.write(JSON.stringify(message) + '\n')
    })
    transport.onerror = (err) => {
      this.logger.error('Streamable HTTP error:', err)
      if (err.message.includes('Maximum reconnection attempts')) {
        this.invalidate(transport)
      }
    }
    transport.onclose = () => {
      // Once a session has worked, a transport that is no longer in use
      // closing is expected.
      if (this.hasConnected && !this.isCurrent(transport)) return
      this.logger.error('Streamable HTTP connection closed')
      // An upstream that rejects the very first handshake is still a startup
      // failure. Recovery applies only after stdio has a working MCP session.
      if (!this.hasConnected) this.exit(1)
      this.invalidate(transport)
    }
    return transport
  }

  /**
   * While `client` connects, the initialize request it sends carries the
   * protocol version the stdio client asked for, and its result is kept as the
   * reply to the stdio client's own initialize. A fallback client, with no
   * initialize to answer, connects as it is.
   */
  private presentInitialize(client: Client) {
    const initialize = this.initializeMessage
    if (!initialize) return { restore: () => {}, result: () => undefined }
    return interceptRequests(client, (request) => {
      if (
        InitializeRequestSchema.safeParse(request).success &&
        initialize.params?.protocolVersion
      ) {
        const params = request.params as { protocolVersion?: unknown }
        params.protocolVersion = initialize.params.protocolVersion
      }
    })
  }

  /** Connect, or join the connection under way; resolves to its handshake. */
  connect(): Promise<unknown> {
    if (this.connecting) return this.connecting
    this.reconnects.cancel()
    const transport = this.openTransport()
    const client = new Client(...upstreamClientIdentity(this.initializeMessage))
    const handshake = this.presentInitialize(client)
    this.connecting = client
      .connect(transport)
      .then(() => {
        handshake.restore()
        this.connection = { client, transport }
        this.hasConnected = true
        this.reconnects.reset()
        this.logger.info('Streamable HTTP connected')
        return handshake.result()
      })
      .catch(async (err) => {
        handshake.restore()
        try {
          await client.close()
        } catch {
          // Preserve the connection failure as the error returned to stdio.
        }
        if (this.hasConnected) this.reconnects.backOff()
        throw err
      })
      .finally(() => {
        this.connecting = undefined
        if (!this.connection) this.scheduleReconnect()
      })
    return this.connecting
  }

  /**
   * Whether `req` is the stdio client's initialize, arriving before any
   * connection began, so the upstream handshake answers it.
   */
  private opensSession(req: JSONRPCRequest) {
    return (
      req.method === 'initialize' && !this.initializeMessage && !this.connecting
    )
  }

  /** A stdio request, answered by the upstream server. */
  async request(req: JSONRPCRequest, signal: AbortSignal, attempt: Attempt) {
    rejectMalformedInitialize(req)
    if (!this.connection) {
      if (this.opensSession(req)) {
        this.initializeMessage = req
        return this.connect()
      }
      this.logger.info(
        this.initializeMessage
          ? 'Reconnecting Streamable HTTP client'
          : 'Streamable HTTP client not initialized, creating fallback client',
      )
      await this.connect()
      // The request that triggered the fallback still has to be answered.
      // Creating the client was never the point of it.
    }
    const { client, transport } = this.connection!
    attempt.transport = transport
    return client.request(req, z.any(), {
      signal,
      timeout: MAX_TIMEOUT_MS,
    })
  }

  /**
   * A failed request. If the upstream lost the connection it was sent on, the
   * next request gets a fresh one.
   */
  failed(err: unknown, attempt: Attempt) {
    if (upstreamLost(err) && attempt.transport) {
      this.invalidate(attempt.transport)
    }
  }

  /**
   * End the upstream session. Bounded: an upstream that does not answer must
   * not hold up the exit.
   */
  async endSession() {
    if (!this.connection?.transport.sessionId) return
    const ended = this.connection.transport.terminateSession().catch((err) => {
      this.logger.error('Failed to end the upstream session:', err)
    })
    await Promise.race([
      ended,
      delay(END_SESSION_TIMEOUT_MS, undefined, { ref: false }),
    ])
  }
}
