import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  ClientCapabilities,
  Implementation,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getVersion } from '../lib/getVersion.js'
import { Logger } from '../types.js'
import { onSignals } from '../lib/onSignals.js'
import { describeHeaders } from '../lib/headers.js'
import { parseUpstreamUrl, redactUrl } from '../lib/urlCredentials.js'
import { relayClientMessage } from '../lib/relayClientMessage.js'
import { relayServerMessages } from '../lib/relayServerMessages.js'
import { CancellableRequests } from '../lib/cancellableRequests.js'
import { MAX_TIMEOUT_MS } from '../lib/longTimeout.js'
import { readAsDrained } from '../lib/outputBackpressure.js'
import { errorResponse, resultResponse } from '../lib/bridgeResponses.js'

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

const newInitializeSseClient = ({ message }: { message: JSONRPCRequest }) => {
  const clientInfo = message.params?.clientInfo as Implementation | undefined
  const clientCapabilities = message.params?.capabilities as
    ClientCapabilities | undefined

  return new Client(
    {
      name: clientInfo?.name ?? 'supergateway',
      version: clientInfo?.version ?? getVersion(),
    },
    {
      capabilities: clientCapabilities ?? {},
    },
  )
}

const newFallbackSseClient = async ({
  connect,
}: {
  connect: (client: Client) => Promise<void>
}) => {
  const fallbackSseClient = new Client(
    {
      name: 'supergateway',
      version: getVersion(),
    },
    {
      capabilities: {},
    },
  )

  await connect(fallbackSseClient)
  return fallbackSseClient
}

export async function sseToStdio(args: SseToStdioArgs) {
  const { sseUrl, logger, headers } = args

  const upstreamUrl = parseUpstreamUrl(sseUrl)

  logger.info(`  - sse: ${redactUrl(upstreamUrl)}`)
  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  logger.info('Connecting to SSE...')

  onSignals({ logger })

  let streamOpened = false
  const sseTransport = new SSEClientTransport(upstreamUrl, {
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
        if (response.ok) streamOpened = true
        // Read the event stream only as fast as the stdio client reads.
        return readAsDrained(response, process.stdout)
      },
    },
    requestInit: {
      headers,
    },
  })

  sseTransport.onerror = (err) => {
    logger.error('SSE error:', err)
  }

  const connectUpstream = async (client: Client) => {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const seconds = SSE_HANDSHAKE_TIMEOUT_MS / 1000
        reject(
          new SseHandshakeTimeout(
            streamOpened
              ? `SSE server at ${redactUrl(upstreamUrl)} opened an event stream but sent no \`endpoint\` event within ${seconds}s. An MCP SSE server must first send \`event: endpoint\` with the URL to POST messages to. If this server uses Streamable HTTP, connect with --streamableHttp instead.`
              : `SSE server at ${redactUrl(upstreamUrl)} did not open an event stream within ${seconds}s.`,
          ),
        )
      }, SSE_HANDSHAKE_TIMEOUT_MS)
    })
    try {
      // A late settlement of the losing `connect` is absorbed by `race`.
      await Promise.race([client.connect(sseTransport), deadline])
    } finally {
      clearTimeout(timer)
    }
  }

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

  const inFlight = new CancellableRequests(logger)

  const handleStdioMessage = async (message: JSONRPCMessage) => {
    const isRequest = 'method' in message && 'id' in message
    if (isRequest) {
      logger.info('Stdio → SSE:', message)
      const req = message as JSONRPCRequest
      let result
      const signal = inFlight.begin(req.id)

      try {
        if (!sseClient) {
          if (message.method === 'initialize') {
            sseClient = newInitializeSseClient({
              message,
            })

            const originalRequest = sseClient.request

            sseClient.request = async function (requestMessage, ...restArgs) {
              // pass protocol version from original client
              if (
                requestMessage.method === 'initialize' &&
                message.params?.protocolVersion &&
                requestMessage.params?.protocolVersion
              ) {
                requestMessage.params.protocolVersion =
                  message.params.protocolVersion
              }

              result = await originalRequest.apply(this, [
                requestMessage,
                ...restArgs,
              ])

              return result
            }

            await connectUpstream(sseClient)
            sseClient.request = originalRequest
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
        } else {
          result = await sseClient.request(req, z.any(), {
            signal,
            timeout: MAX_TIMEOUT_MS,
          })
        }
      } catch (err) {
        inFlight.end(req.id)
        // The client cancelled it, and expects no reply.
        if (signal.aborted) return
        logger.error('Request error:', err)
        const errorResp = errorResponse(req, err)
        const line = JSON.stringify(errorResp) + '\n'
        if (err instanceof SseHandshakeTimeout) {
          // The SDK's transport cannot be started a second time, so there is
          // nothing left to serve. Closing it exits through `onclose`, once the
          // client has been told why.
          process.stdout.write(line, () => void sseTransport.close())
          return
        }
        process.stdout.write(line)
        return
      }
      // See resultResponse: whatever `request` returned is a result.
      const response = resultResponse(req, result)
      logger.info('Response:', response)
      process.stdout.write(JSON.stringify(response) + '\n')
    } else if (!inFlight.cancel(message)) {
      await relayClientMessage({
        message,
        send: sseClient ? (relayed) => sseTransport.send(relayed) : undefined,
        label: 'SSE',
        logger,
      })
    }
  }

  // The SDK calls `onmessage` synchronously and drops whatever it returns, so
  // an async handler assigned straight to it had nothing holding its promise:
  // any throw became an unhandled rejection, which Node turns into an immediate
  // exit. The tail of the handler is outside its own try/catch and dereferences
  // `result`, which is never assigned on the fallback path — so this was
  // reachable by a client whose first request is not `initialize`.
  //
  // This stops that being fatal. It does not make the request succeed: the
  // client still gets no reply, which is GW-001's separate defect.
  // The promise is deliberately returned rather than dropped: tests drive this
  // handler directly and await it, and the SDK ignoring the value costs
  // nothing. `no-misused-promises` exists to stop a rejection escaping a void
  // slot, and the `.catch` below is exactly that guarantee — it handles every
  // rejection and cannot itself throw — so the rule's concern does not apply.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  stdioServer.transport!.onmessage = (message: JSONRPCMessage) =>
    handleStdioMessage(message).catch((err) => {
      logger.error('Unhandled error while handling a stdio message:', err)
    })

  logger.info('Stdio server listening')
}
