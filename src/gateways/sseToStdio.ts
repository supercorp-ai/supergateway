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

export interface SseToStdioArgs {
  sseUrl: string
  logger: Logger
  headers: Record<string, string>
}

let sseClient: Client | undefined

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
  sseTransport,
}: {
  sseTransport: SSEClientTransport
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

  await fallbackSseClient.connect(sseTransport)
  return fallbackSseClient
}

export async function sseToStdio(args: SseToStdioArgs) {
  const { sseUrl, logger, headers } = args

  logger.info(`  - sse: ${sseUrl}`)
  logger.info(
    `  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info('Connecting to SSE...')

  onSignals({ logger })

  const sseTransport = new SSEClientTransport(new URL(sseUrl), {
    eventSourceInit: {
      fetch: (...props: Parameters<typeof fetch>) => {
        const [url, init = {}] = props
        return fetch(url, { ...init, headers: { ...init.headers, ...headers } })
      },
    },
    requestInit: {
      headers,
    },
  })

  sseTransport.onerror = (err) => {
    logger.error('SSE error:', err)
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

  stdioServer.transport!.onmessage = async (message: JSONRPCMessage) => {
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

            sseClient.request = async function (...args) {
              result = await originalRequest.apply(this, args)
              return result
            }

            await sseClient.connect(sseTransport)
            sseClient.request = originalRequest
          } else {
            logger.info('SSE client not initialized, creating fallback client')
            sseClient = await newFallbackSseClient({ sseTransport })
          }

          logger.info('SSE connected')
        } else {
          result = await sseClient.request(req, z.any())
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
      logger.info('SSE → Stdio:', message)
      process.stdout.write(JSON.stringify(message) + '\n')
    }
  }

  logger.info('Stdio server listening')
}
