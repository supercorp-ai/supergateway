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
import { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js'

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

  stdioServer.transport!.onmessage = async (message: JSONRPCMessage) => {
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
                // respect the protocol version from the stdio client's init request
                ;(possibleInitRequestMessage.params as any).protocolVersion =
                  message.params.protocolVersion
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
          }

          logger.info('Streamable HTTP connected')
        } else {
          result = await mcpClient.request<AnySchema>(req, z.any() as any)
        }
      } catch (err) {
        logger.error('Request error:', err)
        const errorCode =
          err && typeof err === 'object' && 'code' in err
            ? (err as any).code
            : -32000
        let errorMsg =
          err && typeof err === 'object' && 'message' in err
            ? (err as any).message
            : 'Internal error'
        const prefix = `MCP error ${errorCode}:`
        if (errorMsg.startsWith(prefix)) {
          errorMsg = errorMsg.slice(prefix.length).trim()
        }
        const errorResp = wrapResponse(req, {
          error: {
            code: errorCode,
            message: errorMsg,
          },
        })
        process.stdout.write(JSON.stringify(errorResp) + '\n')
        return
      }
      const response = wrapResponse(
        req,
        result.hasOwnProperty('error')
          ? { error: { ...result.error } }
          : { result: { ...result } },
      )
      logger.info('Response:', response)
      process.stdout.write(JSON.stringify(response) + '\n')
    } else {
      logger.info('Streamable HTTP → Stdio:', message)
      process.stdout.write(JSON.stringify(message) + '\n')
    }
  }

  logger.info('Stdio server listening')
}
