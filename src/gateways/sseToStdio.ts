import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  JSONRPCMessage,
  JSONRPCRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { getVersion } from '../lib/getVersion.js'
import { Logger } from '../types.js'
import { onSignals } from '../lib/onSignals.js'
import { parseHeaders } from '../lib/parseHeaders.js'

export interface SseToStdioArgs {
  sseUrl: string
  logger: Logger
  headers?: string[]
}

export async function sseToStdio(args: SseToStdioArgs) {
  const { sseUrl, logger, headers: cliHeaders = [] } = args
  const headers = parseHeaders(cliHeaders, logger)

  logger.info(`  - sse: ${sseUrl}`)
  logger.info(
    `  - Headers: ${cliHeaders.length ? JSON.stringify(cliHeaders) : '(none)'}`,
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

  const sseClient = new Client(
    { name: 'supergateway', version: getVersion() },
    { capabilities: {} },
  )

  sseTransport.onerror = (err) => {
    logger.error('SSE error:', err)
  }
  sseTransport.onclose = () => {
    logger.error('SSE connection closed')
    process.exit(1)
  }

  await sseClient.connect(sseTransport)
  logger.info('SSE connected')

  const stdioServer = new Server(
    sseClient.getServerVersion() ?? {
      name: 'supergateway',
      version: getVersion(),
    },
    { capabilities: sseClient.getServerCapabilities() },
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
        result = await sseClient.request(req, z.any())
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
