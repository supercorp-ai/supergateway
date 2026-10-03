import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getVersion } from '../lib/getVersion.js'
import { Logger } from '../types.js'
import { onSignals } from '../lib/onSignals.js'
import { describeHeaders } from '../lib/headers.js'
import { parseUpstreamUrl, redactUrl } from '../lib/urlCredentials.js'
import { relayServerMessages } from '../lib/relayServerMessages.js'
import { MAX_TIMEOUT_MS } from '../lib/longTimeout.js'
import { readAsDrained } from '../lib/outputBackpressure.js'
import {
  bridgeStdioMessages,
  interceptRequests,
  upstreamClientIdentity,
} from '../lib/stdioBridge.js'

export interface SseToStdioArgs {
  sseUrl: string
  logger: Logger
  headers: Record<string, string>
}

let sseClient: Client | undefined

// A compliant MCP SSE server sends `event: endpoint` — the URL to POST
// messages to — as the first thing on a new stream, and the SDK's handshake
// waits for it with no deadline. A server that opened the stream and never sent
// one (#27, a hand-written C++ server) left every client request pending
// forever, with nothing logged after "Connecting to SSE...". Thirty seconds is
// far longer than any compliant server takes, and shorter than the minute a
// desktop client typically waits, so the client still receives the reason.
const SSE_HANDSHAKE_TIMEOUT_MS = 30_000

class SseHandshakeTimeout extends Error {}

const newFallbackSseClient = async ({
  connect,
}: {
  connect: (client: Client) => Promise<void>
}) => {
  const fallbackSseClient = new Client(...upstreamClientIdentity())

  await connect(fallbackSseClient)
  return fallbackSseClient
}

/**
 * The transport to the upstream SSE server. The SDK can start it once, so a
 * bridge has exactly one; `opened` says whether its event stream ever opened.
 */
const openSseTransport = (
  upstreamUrl: URL,
  headers: Record<string, string>,
  logger: Logger,
) => {
  const stream = { opened: false }
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
  stream: { opened: boolean },
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
 * The stdio client's first request, which connects the bridge's client: an
 * initialize as the stdio client's own handshake, anything else through a
 * fallback client.
 */
const connectFor = async (
  req: JSONRPCRequest,
  signal: AbortSignal,
  connectUpstream: (client: Client) => Promise<void>,
  logger: Logger,
) => {
  let result
  if (req.method === 'initialize') {
    sseClient = new Client(...upstreamClientIdentity(req))

    const intercepted = interceptRequests(sseClient, (requestMessage) => {
      // pass protocol version from original client
      if (
        requestMessage.method === 'initialize' &&
        req.params?.protocolVersion &&
        requestMessage.params?.protocolVersion
      ) {
        requestMessage.params.protocolVersion = req.params.protocolVersion
      }
    })

    await connectUpstream(sseClient)
    intercepted.restore()
    result = intercepted.result()
  } else {
    logger.info('SSE client not initialized, creating fallback client')
    sseClient = await newFallbackSseClient({
      connect: connectUpstream,
    })
    // The request that triggered the fallback still has to be
    // answered. Creating the client was never the point of it.
    result = await sseClient.request(req, z.any(), {
      signal,
      timeout: MAX_TIMEOUT_MS,
    })
  }

  logger.info('SSE connected')
  return result
}

export async function sseToStdio(args: SseToStdioArgs) {
  const { sseUrl, logger, headers } = args

  const upstreamUrl = parseUpstreamUrl(sseUrl)

  logger.info(`  - sse: ${redactUrl(upstreamUrl)}`)
  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  logger.info('Connecting to SSE...')

  onSignals({ logger })

  const { transport: sseTransport, stream } = openSseTransport(
    upstreamUrl,
    headers,
    logger,
  )

  const connectUpstream = (client: Client) =>
    connectWithin(client, sseTransport, stream, upstreamUrl)

  relayServerMessages(sseTransport, (message) => {
    logger.info('SSE → Stdio:', message)
    process.stdout.write(JSON.stringify(message) + '\n')
  })

  sseTransport.onclose = () => {
    logger.error('SSE connection closed')
    process.exit(1)
  }

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
    label: 'SSE',
    logger,
    request: (req, signal) => {
      if (!sseClient) return connectFor(req, signal, connectUpstream, logger)
      return sseClient.request(req, z.any(), {
        signal,
        timeout: MAX_TIMEOUT_MS,
      })
    },
    // The SDK's transport cannot be started a second time, so after a
    // handshake that timed out there is nothing left to serve. Closing it
    // exits through `onclose`, once the client has been told why.
    failed: (err) =>
      err instanceof SseHandshakeTimeout
        ? () => void sseTransport.close()
        : undefined,
    send: () =>
      sseClient ? (relayed) => sseTransport.send(relayed) : undefined,
  })

  logger.info('Stdio server listening')
}
