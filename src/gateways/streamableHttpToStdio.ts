import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
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
  upstreamClientIdentity,
} from '../lib/stdioBridge.js'
import { MAX_TIMEOUT_MS } from '../lib/longTimeout.js'

export interface StreamableHttpToStdioArgs {
  streamableHttpUrl: string
  logger: Logger
  headers: Record<string, string>
}

/**
 * Whether a request failed because the upstream no longer serves this
 * connection, so the next request needs a fresh one.
 */
const upstreamLost = (err: unknown) => {
  const rawCode =
    err && typeof err === 'object' && 'code' in err
      ? (err as any).code
      : undefined
  // A 404 means the server no longer recognizes this MCP session. A fresh
  // transport must initialize before the next stdio request. Never replay the
  // failed request: a tool call may have had side effects.
  // SDK 1.18-1.23 wrap HTTP failures in a generic MCP error rather than
  // exposing the status as `code`. Recognize that transport's specific message
  // too, so an expired session reconnects there.
  const legacyHttpFailure =
    err instanceof Error &&
    /^(?:MCP error -32000: )?Error POSTing to endpoint \(HTTP (?:404|5\d\d)\):/.test(
      err.message,
    )
  const transportHttpFailure =
    err instanceof Error &&
    /^Streamable HTTP error: Error POSTing to endpoint:/.test(err.message) &&
    (rawCode === 404 || (typeof rawCode === 'number' && rawCode >= 500))
  return (
    transportHttpFailure ||
    (err instanceof TypeError && /fetch failed/i.test(err.message)) ||
    legacyHttpFailure
  )
}

/** One stdio request: the transport it was sent on, once it was. */
interface Attempt {
  transport?: StreamableHTTPClientTransport
}

/**
 * The bridge's connection to the upstream server: the SDK client and its
 * transport, installed and cleared together, and their replacement after the
 * upstream is lost once a session has worked.
 */
class Upstream {
  client: Client | undefined
  transport: StreamableHTTPClientTransport | undefined
  private initializeMessage: JSONRPCRequest | undefined
  private connecting: Promise<unknown> | undefined
  private reconnectTimer: NodeJS.Timeout | undefined
  private reconnectDelay = 1000
  private hasConnected = false

  constructor(
    private readonly url: URL,
    private readonly headers: Record<string, string>,
    private readonly logger: Logger,
  ) {}

  private invalidate(transport: StreamableHTTPClientTransport) {
    if (this.transport !== transport) return
    // The client and transport are installed and cleared together.
    const stale = this.client!
    this.client = undefined
    this.transport = undefined
    void Promise.resolve()
      .then(() => stale.close())
      .catch((err) =>
        this.logger.error('Failed to close stale Streamable HTTP client:', err),
      )
    this.scheduleReconnect()
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || !this.hasConnected) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      void this.connect().catch((err) => {
        this.logger.error('Streamable HTTP reconnect failed:', err)
      })
    }, this.reconnectDelay)
    this.reconnectTimer.unref()
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
      // An upstream that rejects the very first handshake is still a startup
      // failure. Recovery applies only after stdio has a working MCP session.
      if (!this.hasConnected) {
        this.logger.error('Streamable HTTP connection closed')
        process.exit(1)
      }
      if (this.transport === transport) {
        this.logger.error('Streamable HTTP connection closed')
        this.invalidate(transport)
      }
    }
    return transport
  }

  /** Connect, or join the connection under way; resolves to its handshake. */
  connect(): Promise<unknown> {
    if (this.connecting) return this.connecting
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    const transport = this.openTransport()
    const initForConnection = this.initializeMessage
    const client = new Client(...upstreamClientIdentity(initForConnection))
    let initializeResult: unknown
    const originalRequest = client.request
    if (initForConnection) {
      client.request = async function (
        possibleInitRequestMessage,
        ...restArgs
      ) {
        if (
          InitializeRequestSchema.safeParse(possibleInitRequestMessage)
            .success &&
          initForConnection.params?.protocolVersion
        ) {
          const params = possibleInitRequestMessage.params as {
            protocolVersion?: unknown
          }
          params.protocolVersion = initForConnection.params.protocolVersion
        }
        initializeResult = await originalRequest.apply(this, [
          possibleInitRequestMessage,
          ...restArgs,
        ])
        return initializeResult as Awaited<ReturnType<typeof originalRequest>>
      }
    }
    this.connecting = client
      .connect(transport)
      .then(() => {
        client.request = originalRequest
        this.client = client
        this.transport = transport
        this.hasConnected = true
        this.reconnectDelay = 1000
        this.logger.info('Streamable HTTP connected')
        return initializeResult
      })
      .catch(async (err) => {
        client.request = originalRequest
        try {
          await client.close()
        } catch {
          // Preserve the connection failure as the error returned to stdio.
        }
        if (this.hasConnected)
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000)
        throw err
      })
      .finally(() => {
        this.connecting = undefined
        if (!this.client) this.scheduleReconnect()
      })
    return this.connecting
  }

  /** A stdio request, answered by the upstream server. */
  async request(req: JSONRPCRequest, signal: AbortSignal, attempt: Attempt) {
    if (
      req.method === 'initialize' &&
      req.params !== undefined &&
      !InitializeRequestSchema.safeParse(req).success
    ) {
      throw Object.assign(new Error('Invalid initialize parameters'), {
        code: -32602,
      })
    }
    if (!this.client) {
      if (
        req.method === 'initialize' &&
        !this.initializeMessage &&
        !this.connecting
      ) {
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
    attempt.transport = this.transport
    return this.client!.request(req, z.any(), {
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
    if (!this.transport?.sessionId) return
    const ended = this.transport.terminateSession().catch((err) => {
      this.logger.error('Failed to end the upstream session:', err)
    })
    await Promise.race([ended, delay(2000, undefined, { ref: false })])
  }
}

export async function streamableHttpToStdio(args: StreamableHttpToStdioArgs) {
  const { streamableHttpUrl, logger, headers } = args
  const upstreamUrl = parseUpstreamUrl(streamableHttpUrl)

  logger.info(`  - streamableHttp: ${redactUrl(upstreamUrl)}`)
  logger.info(`  - Headers: ${describeHeaders(headers)}`)
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
    label: 'Streamable HTTP',
    logger,
    request: (req, signal, attempt: Attempt) =>
      upstream.request(req, signal, attempt),
    failed: (err, attempt) => upstream.failed(err, attempt),
    send: () =>
      upstream.client
        ? (relayed) => upstream.transport!.send(relayed)
        : undefined,
  })

  logger.info('Stdio server listening')
}
