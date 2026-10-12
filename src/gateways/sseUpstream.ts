import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { Logger } from '../types.js'
import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { MAX_TIMEOUT_MS } from '../lib/longTimeout.js'
import {
  upstreamClientIdentity,
  interceptRequests,
  type BridgeLifecycle,
} from '../lib/stdioBridge.js'
import { readAsDrained } from '../lib/outputBackpressure.js'
import { relayServerMessages } from '../lib/relayServerMessages.js'
import { redactUrl } from '../lib/urlCredentials.js'

// A compliant MCP SSE server sends `event: endpoint` — the URL to POST
// messages to — as the first thing on a new stream, and the SDK's handshake
// waits for it with no deadline. A server that opened the stream and never sent
// one (#27, a hand-written C++ server) left every client request pending
// forever, with nothing logged after "Connecting to SSE...". Thirty seconds is
// far longer than any compliant server takes, and shorter than the minute a
// desktop client typically waits, so the client still receives the reason.
const SSE_HANDSHAKE_TIMEOUT_MS = 30_000

export class SseHandshakeTimeout extends Error {}

/** Whether the upstream's event stream ever opened. */
interface EventStream {
  opened: boolean
}

/**
 * The transport to the upstream SSE server, relaying what the server sends to
 * stdout. The SDK can start it once, so a bridge has exactly one, and the
 * bridge exits when it closes.
 */
export const openSseTransport = (
  upstreamUrl: URL,
  headers: Record<string, string>,
  logger: Logger,
  exit: BridgeLifecycle['exit'],
) => {
  const stream: EventStream = { opened: false }
  const transport = new SSEClientTransport(upstreamUrl, {
    eventSourceInit: {
      fetch: async (...props: Parameters<typeof fetch>) => {
        const [url, init = {}] = props
        // The SDK passes a `Headers` object, and spreading one yields `{}`: the
        // stream request lost `Accept: text/event-stream` (sent as `*/*`) and
        // every other header the SDK set. Merge, and let --header win.
        const merged = new Headers(init.headers)
        for (const [name, value] of Object.entries(headers))
          merged.set(name, value)
        const response = await fetch(url, { ...init, headers: merged })
        if (response.ok) stream.opened = true
        // Read the event stream only as fast as the stdio client reads.
        return readAsDrained(response, process.stdout)
      },
    },
    requestInit: {
      headers,
    },
  })

  transport.onerror = (err) => {
    logger.error('SSE error:', err)
  }

  relayServerMessages(transport, (message) => {
    logger.info('SSE → Stdio:', message)
    process.stdout.write(JSON.stringify(message) + '\n')
  })

  transport.onclose = () => {
    logger.error('SSE connection closed')
    exit(1)
  }
  return { transport, stream }
}

/**
 * Connect `client` over `transport`, or give up at the handshake deadline,
 * saying which half of the handshake never came.
 */
const connectWithin = async (
  client: Client,
  transport: SSEClientTransport,
  // Read when the deadline passes: the stream can open after the connect began.
  stream: EventStream,
  upstreamUrl: URL,
) => {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const seconds = SSE_HANDSHAKE_TIMEOUT_MS / 1000
      reject(
        new SseHandshakeTimeout(
          stream.opened
            ? `SSE server at ${redactUrl(upstreamUrl)} opened an event stream but sent no \`endpoint\` event within ${seconds}s. An MCP SSE server must first send \`event: endpoint\` with the URL to POST messages to. If this server uses Streamable HTTP, connect with --streamableHttp instead.`
            : `SSE server at ${redactUrl(upstreamUrl)} did not open an event stream within ${seconds}s.`,
        ),
      )
    }, SSE_HANDSHAKE_TIMEOUT_MS)
  })
  try {
    // A late settlement of the losing `connect` is absorbed by `race`.
    await Promise.race([client.connect(transport), deadline])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The bridge's client to the upstream SSE server, connected over the bridge's
 * one transport by the stdio client's first request.
 */
export class Upstream {
  client: Client | undefined

  constructor(
    private readonly transport: SSEClientTransport,
    private readonly stream: EventStream,
    private readonly url: URL,
    private readonly logger: Logger,
  ) {}

  private connect(client: Client) {
    return connectWithin(client, this.transport, this.stream, this.url)
  }

  /** A stdio request, answered by the upstream server. */
  request(req: JSONRPCRequest, signal: AbortSignal) {
    if (!this.client) return this.connectFor(req, signal)
    return this.client.request(req, z.any(), {
      signal,
      timeout: MAX_TIMEOUT_MS,
    })
  }

  /**
   * The stdio client's first request, which connects the bridge's client: an
   * initialize as the stdio client's own handshake, anything else through a
   * fallback client.
   */
  private async connectFor(req: JSONRPCRequest, signal: AbortSignal) {
    let result
    if (req.method === 'initialize') {
      this.client = new Client(...upstreamClientIdentity(req))

      const intercepted = interceptRequests(this.client, (requestMessage) => {
        // pass protocol version from original client
        if (
          requestMessage.method === 'initialize' &&
          req.params?.protocolVersion &&
          requestMessage.params?.protocolVersion
        ) {
          requestMessage.params.protocolVersion = req.params.protocolVersion
        }
      })

      await this.connect(this.client)
      intercepted.restore()
      result = intercepted.result()
    } else {
      this.logger.info('SSE client not initialized, creating fallback client')
      this.client = await this.connectedFallbackClient()
      // The request that triggered the fallback still has to be
      // answered. Creating the client was never the point of it.
      result = await this.client.request(req, z.any(), {
        signal,
        timeout: MAX_TIMEOUT_MS,
      })
    }

    this.logger.info('SSE connected')
    return result
  }

  /** A client in the gateway's own name, once it has connected. */
  private async connectedFallbackClient() {
    const fallbackSseClient = new Client(...upstreamClientIdentity())

    await this.connect(fallbackSseClient)
    return fallbackSseClient
  }
}
