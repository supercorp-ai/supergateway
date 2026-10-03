import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import {
  ErrorCode,
  InitializeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getVersion } from '../lib/getVersion.js'
import { Logger } from '../types.js'
import { setTimeout as delay } from 'node:timers/promises'
import { onSignals } from '../lib/onSignals.js'
import { describeHeaders } from '../lib/headers.js'
import { parseUpstreamUrl, redactUrl } from '../lib/urlCredentials.js'
import { relayServerMessages } from '../lib/relayServerMessages.js'
import { readAsDrained } from '../lib/outputBackpressure.js'
import {
  bridgeStdioMessages,
  interceptRequests,
  upstreamClientIdentity,
} from '../lib/stdioBridge.js'
import { MAX_TIMEOUT_MS } from '../lib/longTimeout.js'
import type { ToolNames } from '../lib/toolNames.js'

export interface StreamableHttpToStdioArgs {
  streamableHttpUrl: string
  logger: Logger
  headers: Record<string, string>
  /** The tools the stdio client sees of the server, if not all as they are. */
  toolNames?: ToolNames
}

const FIRST_RECONNECT_DELAY_MS = 1000
const MAX_RECONNECT_DELAY_MS = 30_000

// How long ending the upstream session may hold up the exit.
const END_SESSION_TIMEOUT_MS = 2000

/**
 * Whether a request failed because the upstream no longer serves this
 * connection, so the next request needs a fresh one.
 *
 * A 404 means the server no longer recognizes this MCP session. A fresh
 * transport must initialize before the next stdio request. Never replay the
 * failed request: a tool call may have had side effects.
 */
const upstreamLost = (err: unknown) => {
  const rawCode =
    err && typeof err === 'object' && 'code' in err
      ? (err as { code: unknown }).code
      : undefined
  const transportHttpFailure =
    err instanceof Error &&
    /^Streamable HTTP error: Error POSTing to endpoint:/.test(err.message) &&
    (rawCode === 404 || (typeof rawCode === 'number' && rawCode >= 500))
  const fetchFailed =
    err instanceof TypeError && /fetch failed/i.test(err.message)
  // SDK 1.18-1.23 wrap HTTP failures in a generic MCP error rather than
  // exposing the status as `code`. Recognize that transport's specific message
  // too, so an expired session reconnects there.
  const legacyHttpFailure =
    err instanceof Error &&
    /^(?:MCP error -32000: )?Error POSTing to endpoint \(HTTP (?:404|5\d\d)\):/.test(
      err.message,
    )
  return transportHttpFailure || fetchFailed || legacyHttpFailure
}

/**
 * Refuse an initialize request with malformed params, as invalid params,
 * before anything is sent upstream.
 */
const rejectMalformedInitialize = (req: JSONRPCRequest) => {
  if (
    req.method === 'initialize' &&
    req.params !== undefined &&
    !InitializeRequestSchema.safeParse(req).success
  ) {
    throw Object.assign(new Error('Invalid initialize parameters'), {
      code: ErrorCode.InvalidParams,
    })
  }
}

/** One stdio request: the transport it was sent on, once it was. */
interface Attempt {
  transport?: StreamableHTTPClientTransport
}

/** The SDK client and the transport it connected over, in use together. */
interface Connection {
  client: Client
  transport: StreamableHTTPClientTransport
}

/**
 * When the next reconnect runs. After the upstream is lost, the first one waits
 * a second, and each failed one doubles the wait, up to half a minute. At most
 * one is pending at a time.
 */
class ReconnectSchedule {
  private timer: NodeJS.Timeout | undefined
  private delay = FIRST_RECONNECT_DELAY_MS

  /** Run `reconnect` after the current wait, unless one is already pending. */
  schedule(reconnect: () => void) {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      reconnect()
    }, this.delay)
    this.timer.unref()
  }

  /** Drop the pending reconnect: a connection is starting anyway. */
  cancel() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** A reconnect failed: wait longer before the next. */
  backOff() {
    this.delay = Math.min(this.delay * 2, MAX_RECONNECT_DELAY_MS)
  }

  /** A connection succeeded: the next loss starts from the first wait again. */
  reset() {
    this.delay = FIRST_RECONNECT_DELAY_MS
  }
}

/**
 * The bridge's connection to the upstream server, and its replacement after
 * the upstream is lost once a session has worked.
 */
class Upstream {
  connection: Connection | undefined
  private initializeMessage: JSONRPCRequest | undefined
  private connecting: Promise<unknown> | undefined
  private readonly reconnects = new ReconnectSchedule()
  private hasConnected = false

  constructor(
    private readonly url: URL,
    private readonly headers: Record<string, string>,
    private readonly logger: Logger,
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
      if (!this.hasConnected) process.exit(1)
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

export async function streamableHttpToStdio(args: StreamableHttpToStdioArgs) {
  const { streamableHttpUrl, logger, headers, toolNames } = args
  const upstreamUrl = parseUpstreamUrl(streamableHttpUrl)

  logger.info(`  - streamableHttp: ${redactUrl(upstreamUrl)}`)
  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  toolNames?.describe().forEach((setting) => logger.info(`  - ${setting}`))
  logger.info('Connecting to Streamable HTTP...')

  const upstream = new Upstream(upstreamUrl, headers, logger)

  onSignals({
    logger,
    // A stateful upstream keeps this session, and the server process behind it,
    // until the session is ended or times out (30 minutes by default). Ending
    // it is the client's job, and the bridge is the client.
    cleanup: () => upstream.endSession(),
  })

  const stdioServer = new Server(
    {
      name: 'supergateway',
      version: getVersion(),
    },
    {
      capabilities: {},
    },
  )

  const stdioTransport = new StdioServerTransport()
  await stdioServer.connect(stdioTransport)

  bridgeStdioMessages(stdioServer.transport!, {
    toolNames,
    label: 'Streamable HTTP',
    logger,
    request: (req, signal, attempt: Attempt) =>
      upstream.request(req, signal, attempt),
    failed: (err, attempt) => upstream.failed(err, attempt),
    send: () =>
      upstream.connection
        ? (relayed) => upstream.connection!.transport.send(relayed)
        : undefined,
  })

  logger.info('Stdio server listening')
}
