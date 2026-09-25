import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type {
  JSONRPCMessage,
  JSONRPCRequest,
  ClientCapabilities,
  Implementation,
} from '@modelcontextprotocol/sdk/types.js'
import { InitializeRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getVersion } from '../lib/getVersion.js'
import { Logger } from '../types.js'
import { onSignals } from '../lib/onSignals.js'
import { describeHeaders } from '../lib/headers.js'
import { parseUpstreamUrl, redactUrl } from '../lib/urlCredentials.js'
import { relayClientMessage } from '../lib/relayClientMessage.js'

export interface StreamableHttpToStdioArgs {
  streamableHttpUrl: string
  logger: Logger
  headers: Record<string, string>
}

const newInitializeMcpClient = ({ message }: { message: JSONRPCRequest }) => {
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

export async function streamableHttpToStdio(args: StreamableHttpToStdioArgs) {
  const { streamableHttpUrl, logger, headers } = args
  const upstreamUrl = parseUpstreamUrl(streamableHttpUrl)

  logger.info(`  - streamableHttp: ${redactUrl(upstreamUrl)}`)
  logger.info(`  - Headers: ${describeHeaders(headers)}`)
  logger.info('Connecting to Streamable HTTP...')

  onSignals({ logger })

  let mcpClient: Client | undefined
  let mcpTransport: StreamableHTTPClientTransport | undefined
  let initializeMessage: JSONRPCRequest | undefined
  let connecting: Promise<unknown> | undefined
  let reconnectTimer: NodeJS.Timeout | undefined
  let reconnectDelay = 1000
  let hasConnected = false

  const invalidateUpstream = (transport: StreamableHTTPClientTransport) => {
    if (mcpTransport !== transport) return
    // The client and transport are installed and cleared together.
    const stale = mcpClient!
    mcpClient = undefined
    mcpTransport = undefined
    void Promise.resolve()
      .then(() => stale.close())
      .catch((err) =>
        logger.error('Failed to close stale Streamable HTTP client:', err),
      )
    scheduleReconnect()
  }

  const scheduleReconnect = () => {
    if (reconnectTimer || !hasConnected) return
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      void connectUpstream().catch((err) => {
        logger.error('Streamable HTTP reconnect failed:', err)
      })
    }, reconnectDelay)
    reconnectTimer.unref()
  }

  const connectUpstream = (): Promise<unknown> => {
    if (connecting) return connecting
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
    const transport = new StreamableHTTPClientTransport(new URL(upstreamUrl), {
      requestInit: { headers },
    })
    transport.onerror = (err) => {
      logger.error('Streamable HTTP error:', err)
      if (err.message.includes('Maximum reconnection attempts')) {
        invalidateUpstream(transport)
      }
    }
    transport.onclose = () => {
      // An upstream that rejects the very first handshake is still a startup
      // failure. Recovery applies only after stdio has a working MCP session.
      if (!hasConnected) {
        logger.error('Streamable HTTP connection closed')
        process.exit(1)
      }
      if (mcpTransport === transport) {
        logger.error('Streamable HTTP connection closed')
        invalidateUpstream(transport)
      }
    }
    const initForConnection = initializeMessage
    const client = initForConnection
      ? newInitializeMcpClient({ message: initForConnection })
      : new Client(
          { name: 'supergateway', version: getVersion() },
          { capabilities: {} },
        )
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
    connecting = client
      .connect(transport)
      .then(() => {
        client.request = originalRequest
        mcpClient = client
        mcpTransport = transport
        hasConnected = true
        reconnectDelay = 1000
        logger.info('Streamable HTTP connected')
        return initializeResult
      })
      .catch(async (err) => {
        client.request = originalRequest
        try {
          await client.close()
        } catch {
          // Preserve the connection failure as the error returned to stdio.
        }
        if (hasConnected) reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
        throw err
      })
      .finally(() => {
        connecting = undefined
        if (!mcpClient) scheduleReconnect()
      })
    return connecting
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
    jsonrpc: '2.0',
    id: req.id,
    ...payload,
  })

  const handleStdioMessage = async (message: JSONRPCMessage) => {
    const isRequest = 'method' in message && 'id' in message
    if (isRequest) {
      logger.info('Stdio → Streamable HTTP:', message)
      const req = message as JSONRPCRequest
      let result
      let requestTransport: StreamableHTTPClientTransport | undefined

      try {
        if (
          message.method === 'initialize' &&
          message.params !== undefined &&
          !InitializeRequestSchema.safeParse(message).success
        ) {
          throw Object.assign(new Error('Invalid initialize parameters'), {
            code: -32602,
          })
        }
        if (!mcpClient) {
          if (
            message.method === 'initialize' &&
            !initializeMessage &&
            !connecting
          ) {
            initializeMessage = message
            result = await connectUpstream()
          } else {
            logger.info(
              initializeMessage
                ? 'Reconnecting Streamable HTTP client'
                : 'Streamable HTTP client not initialized, creating fallback client',
            )
            await connectUpstream()
            // The request that triggered the fallback still has to be
            // answered. Creating the client was never the point of it.
            requestTransport = mcpTransport
            result = await mcpClient!.request(req, z.any())
          }
        } else {
          requestTransport = mcpTransport
          result = await mcpClient.request(req, z.any())
        }
      } catch (err) {
        logger.error('Request error:', err)
        const rawCode =
          err && typeof err === 'object' && 'code' in err
            ? (err as any).code
            : undefined
        // A 404 means the server no longer recognizes this MCP session. A
        // fresh transport must initialize before the next stdio request. Never
        // replay the failed request: a tool call may have had side effects.
        // SDK 1.18-1.23 wrap HTTP failures in a generic MCP error rather
        // than exposing the status as `code`. Recognize that transport's
        // specific message too, so an expired session reconnects there.
        const legacyHttpFailure =
          err instanceof Error &&
          /^(?:MCP error -32000: )?Error POSTing to endpoint \(HTTP (?:404|5\d\d)\):/.test(
            err.message,
          )
        const transportHttpFailure =
          err instanceof Error &&
          /^Streamable HTTP error: Error POSTing to endpoint:/.test(
            err.message,
          ) &&
          (rawCode === 404 || (typeof rawCode === 'number' && rawCode >= 500))
        const networkFailure =
          transportHttpFailure ||
          (err instanceof TypeError && /fetch failed/i.test(err.message)) ||
          legacyHttpFailure
        if (networkFailure && requestTransport) {
          invalidateUpstream(requestTransport)
        }
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
        process.stdout.write(JSON.stringify(errorResp) + '\n')
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
        send: mcpClient ? (relayed) => mcpTransport!.send(relayed) : undefined,
        label: 'Streamable HTTP',
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
