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

export interface StreamableHttpToStdioArgs {
  streamableHttpUrl: string
  logger: Logger
  headers: Record<string, string>
}

let mcpClient: Client | undefined

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

const newFallbackMcpClient = async ({
  mcpTransport,
}: {
  mcpTransport: StreamableHTTPClientTransport
}) => {
  const fallbackMcpClient = new Client(
    {
      name: 'supergateway',
      version: getVersion(),
    },
    {
      capabilities: {},
    },
  )

  await fallbackMcpClient.connect(mcpTransport)
  return fallbackMcpClient
}

export async function streamableHttpToStdio(args: StreamableHttpToStdioArgs) {
  const { streamableHttpUrl, logger, headers } = args

  logger.info(`  - streamableHttp: ${streamableHttpUrl}`)
  logger.info(
    `  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info('Connecting to Streamable HTTP...')

  onSignals({ logger })

  const mcpTransport = new StreamableHTTPClientTransport(
    new URL(streamableHttpUrl),
    {
      requestInit: {
        headers,
      },
    },
  )

  mcpTransport.onerror = (err) => {
    logger.error('Streamable HTTP error:', err)
  }

  mcpTransport.onclose = () => {
    logger.error('Streamable HTTP connection closed')
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
      logger.info('Stdio → Streamable HTTP:', message)
      const req = message as JSONRPCRequest
      let result

      try {
        if (!mcpClient) {
          if (message.method === 'initialize') {
            mcpClient = newInitializeMcpClient({
              message,
            })

            const originalRequest = mcpClient.request

            mcpClient.request = async function (
              possibleInitRequestMessage,
              ...restArgs
            ) {
              if (
                InitializeRequestSchema.safeParse(possibleInitRequestMessage)
                  .success &&
                message.params?.protocolVersion
              ) {
                // Respect the protocol version from the stdio client's init
                // request. From SDK 1.22 `params` is a union of every request
                // shape and only the initialize member carries protocolVersion,
                // so this stopped type-checking; the safeParse above already
                // established both that this is an initialize request and, since
                // that schema requires params, that they are present. The cast
                // records what the guard proved, and types the field `unknown`
                // because the source is `{}` on SDK 1.18 and `string` on 1.30.
                //
                // Kept as a plain assignment rather than the SSE bridge's
                // read-then-overwrite: this bridge sets the version whether or
                // not the request carried one, and matching that spelling here
                // would change behaviour.
                const params = possibleInitRequestMessage.params as {
                  protocolVersion?: unknown
                }
                params.protocolVersion = message.params.protocolVersion
              }
              result = await originalRequest.apply(this, [
                possibleInitRequestMessage,
                ...restArgs,
              ])
              return result
            }

            await mcpClient.connect(mcpTransport)
            mcpClient.request = originalRequest
          } else {
            logger.info(
              'Streamable HTTP client not initialized, creating fallback client',
            )
            mcpClient = await newFallbackMcpClient({ mcpTransport })
            // The request that triggered the fallback still has to be
            // answered. Creating the client was never the point of it.
            result = await mcpClient.request(req, z.any())
          }

          logger.info('Streamable HTTP connected')
        } else {
          result = await mcpClient.request(req, z.any())
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
      logger.info('Streamable HTTP → Stdio:', message)
      process.stdout.write(JSON.stringify(message) + '\n')
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
