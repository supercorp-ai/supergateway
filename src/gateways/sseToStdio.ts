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
import { relayClientMessage } from '../lib/relayClientMessage.js'

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
    | ClientCapabilities
    | undefined

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

  logger.info(`  - sse: ${sseUrl}`)
  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  logger.info('Connecting to SSE...')

  onSignals({ logger })

  let streamOpened = false
  const sseTransport = new SSEClientTransport(new URL(sseUrl), {
    eventSourceInit: {
      fetch: async (...props: Parameters<typeof fetch>) => {
        const [url, init = {}] = props
        const response = await fetch(url, {
          ...init,
          headers: { ...init.headers, ...headers },
        })
        if (response.ok) streamOpened = true
        return response
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
              ? `SSE server at ${sseUrl} opened an event stream but sent no \`endpoint\` event within ${seconds}s. An MCP SSE server must first send \`event: endpoint\` with the URL to POST messages to. If this server uses Streamable HTTP, connect with --streamableHttp instead.`
              : `SSE server at ${sseUrl} did not open an event stream within ${seconds}s.`,
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

  const wrapResponse = (req: JSONRPCRequest, payload: object) => ({
    jsonrpc: req.jsonrpc || '2.0',
    id: req.id,
    ...payload,
  })

  const handleStdioMessage = async (message: JSONRPCMessage) => {
    const isRequest = 'method' in message && 'id' in message
    if (isRequest) {
      logger.info('Stdio → SSE:', message)
      const req = message as JSONRPCRequest
      let result

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
            result = await sseClient.request(req, z.any())
          }

          logger.info('SSE connected')
        } else {
          result = await sseClient.request(req, z.any())
        }
      } catch (err) {
        logger.error('Request error:', err)
        const rawCode =
          err && typeof err === 'object' && 'code' in err
            ? (err as any).code
            : undefined
        // JSON-RPC reserves -32768..-32000 for protocol errors, and every code
        // the SDK's McpError uses falls inside it. A transport error carries
        // something else entirely: from SDK 1.24 a failed POST throws
        // StreamableHTTPError whose `code` is the HTTP status, and forwarding
        // that verbatim put `code: 503` on the wire, which no JSON-RPC client
        // can interpret. Such a status belongs in the message, where it is
        // diagnostic rather than protocol.
        const isProtocolCode =
          typeof rawCode === 'number' &&
          Number.isInteger(rawCode) &&
          rawCode >= -32768 &&
          rawCode <= -32000
        const errorCode = isProtocolCode ? rawCode : -32000
        let errorMsg =
          err && typeof err === 'object' && 'message' in err
            ? (err as any).message
            : 'Internal error'
        const prefix = `MCP error ${errorCode}:`
        if (errorMsg.startsWith(prefix)) {
          errorMsg = errorMsg.slice(prefix.length).trim()
        }
        // Older SDKs spelled the status into the message themselves; newer ones
        // only carry it in the code we just discarded, so keep it either way.
        if (
          !isProtocolCode &&
          typeof rawCode === 'number' &&
          !errorMsg.includes(`HTTP ${rawCode}`)
        ) {
          errorMsg = `HTTP ${rawCode}: ${errorMsg}`
        }
        // Keep whatever structured detail the upstream error carried: it is
        // the part a client can act on, and rebuilding the error without it
        // discarded the most useful half.
        const errorData =
          err && typeof err === 'object' && 'data' in err
            ? (err as { data?: unknown }).data
            : undefined
        const errorResp = wrapResponse(req, {
          error: {
            code: errorCode,
            message: errorMsg,
            ...(errorData === undefined ? {} : { data: errorData }),
          },
        })
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
      // `request` throws on a protocol error, so anything it returns is a
      // successful result — including one that happens to carry a field named
      // `error`, which is application data and not a JSON-RPC error. The old
      // ternary both misread that data and called `hasOwnProperty` off the
      // result itself, which a result carrying that key as a string turned
      // into a crash.
      const response = wrapResponse(req, { result: { ...result } })
      logger.info('Response:', response)
      process.stdout.write(JSON.stringify(response) + '\n')
    } else {
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
