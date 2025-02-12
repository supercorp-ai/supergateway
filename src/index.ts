#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE or vice versa
 *
 * Usage:
 *   # stdio -> SSE
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /some/folder" \
 *                       --port 8000 --baseUrl http://localhost:8000 --ssePath /sse --messagePath /message
 *
 *   # SSE -> stdio
 *   npx -y supergateway --sse "https://mcp-server.superinterface.app"
 */
import { instrumentApp } from './instrumentation/index.js' // This will initialize the instrumentation
instrumentApp().catch(err => {
  logger.error('Fatal error:', err)
  process.exit(1)
})
import { logger } from './logger/index.js'
import express from 'express'
import bodyParser from 'body-parser'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { JSONRPCMessage, JSONRPCRequest } from '@modelcontextprotocol/sdk/types.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { fileURLToPath } from 'url'
import { join, dirname } from 'path'
import { readFileSync } from 'fs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getVersion(): string {
  try {
    const packageJsonPath = join(__dirname, '../package.json')
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'))
    return packageJson.version || '1.0.0'
  } catch (err) {
    logger.error('Unable to retrieve version:', err)
    return 'unknown'
  }
}

const stdioToSse = async (
  stdioCmd: string,
  port: number,
  baseUrl: string,
  ssePath: string,
  messagePath: string
) => {
  logger.info('Starting...')
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  if (baseUrl) {
    logger.info(`  - baseUrl: ${baseUrl}`)
  }
  logger.info(`  - ssePath: ${ssePath}`)
  logger.info(`  - messagePath: ${messagePath}`)

  const child: ChildProcessWithoutNullStreams = spawn(stdioCmd, { shell: true })
  child.on('exit', (code, signal) => {
    logger.error(`Child exited: code=${code}, signal=${signal}`)
    process.exit(code ?? 1)
  })

  const server = new Server(
    { name: 'supergateway', version: getVersion() },
    { capabilities: {} }
  )

  const sessions: Record<string, { transport: SSEServerTransport; response: express.Response }> = {}

  const app = express()
  app.use((req, res, next) => {
    if (req.path === messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  app.get("/health", (req, res) => {
    res.send("OK")
  })

  app.get(ssePath, async (req, res) => {
    logger.info(`New SSE connection from ${req.ip}`)

    const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)
    await server.connect(sseTransport)

    const sessionId = sseTransport.sessionId

    if (sessionId) {
      sessions[sessionId] = { transport: sseTransport, response: res }
    }

    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      const line = JSON.stringify(msg)
      logger.info(`SSE → Child (session ${sessionId}): ${line}`)
      child.stdin.write(line + '\n')
    }

    sseTransport.onclose = () => {
      logger.info(`SSE connection closed (session ${sessionId})`)
      delete sessions[sessionId]
    }

    sseTransport.onerror = err => {
      logger.error(`SSE error (session ${sessionId}):`, err)
      delete sessions[sessionId]
    }

    req.on('close', () => {
      logger.info(`Client disconnected (session ${sessionId})`)
      delete sessions[sessionId]
    })
  })

  // @ts-ignore: ignoring potential type mismatch from express
  app.post(messagePath, async (req, res) => {
    const sessionId = req.query.sessionId as string

    if (!sessionId) {
      return res.status(400).send('Missing sessionId parameter')
    }

    const session = sessions[sessionId]

    if (session?.transport?.handlePostMessage) {
      logger.info(`POST to SSE transport (session ${sessionId})`)
      await session.transport.handlePostMessage(req, res)
    } else {
      res.status(503).send(`No active SSE connection for session ${sessionId}`)
    }
  })

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(`SSE endpoint: http://localhost:${port}${ssePath}`)
    logger.info(`POST messages: http://localhost:${port}${messagePath}`)
  })

  let buffer = ''
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    lines.forEach(line => {
      if (!line.trim()) return
      try {
        const jsonMsg = JSON.parse(line)
        logger.info('Child → SSE:', jsonMsg)

        // Broadcast to all sessions
        for (const [sid, session] of Object.entries(sessions)) {
          try {
            session.transport.send(jsonMsg)
          } catch (err) {
            logger.error(`Failed to send to session ${sid}:`, err)
            delete sessions[sid]
          }
        }
      } catch {
        logger.error(`Child non-JSON: ${line}`)
      }
    })
  })

  child.stderr.on('data', (chunk: Buffer) => {
    logger.info(`Child stderr: ${chunk.toString('utf8')}`)
  })
}

const sseToStdio = async (sseUrl: string) => {
  logger.info('Starting...')
  logger.info('Supergateway is supported by Superinterface - https://superinterface.ai')
  logger.info(`  - sse: ${sseUrl}`)
  logger.info('Connecting to SSE...')

  const sseTransport = new SSEClientTransport(new URL(sseUrl))
  const sseClient = new Client(
    { name: 'supergateway', version: getVersion() },
    { capabilities: {} }
  )

  sseTransport.onerror = err => {
    logger.error('SSE error:', err)
  }
  sseTransport.onclose = () => {
    logger.error('SSE connection closed')
    process.exit(1)
  }

  await sseClient.connect(sseTransport)
  logger.info('SSE connected')

  const stdioServer = new Server(
    sseClient.getServerVersion() ?? { name: 'supergateway', version: getVersion() },
    { capabilities: sseClient.getServerCapabilities() }
  )
  const stdioTransport = new StdioServerTransport()
  await stdioServer.connect(stdioTransport)

  // Build a response envelope using the JSON-RPC version from the request if present.
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
        // Remove the prefix if it is already present.
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
          : { result: { ...result } }
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

const main = async () => {
  const argv = yargs(hideBin(process.argv))
    .option('stdio', {
      type: 'string',
      description: 'Command to run an MCP server over Stdio'
    })
    .option('sse', {
      type: 'string',
      description: 'SSE URL to connect to'
    })
    .option('port', {
      type: 'number',
      default: 8000,
      description: '(stdio to SSE) Port to run on'
    })
    .option('baseUrl', {
      type: 'string',
      default: '',
      description: '(stdio to SSE) Base URL for SSE clients'
    })
    .option('ssePath', {
      type: 'string',
      default: '/sse',
      description: '(stdio to SSE) Path for SSE subscriptions'
    })
    .option('messagePath', {
      type: 'string',
      default: '/message',
      description: '(stdio to SSE) Path for SSE messages'
    })
    .help()
    .parseSync()

  const hasStdio = Boolean(argv.stdio)
  const hasSse = Boolean(argv.sse)

  if (hasStdio && hasSse) {
    logger.error('Error: Specify only one of --stdio or --sse, not both')
    process.exit(1)
  }
  else if (!hasStdio && !hasSse) {
    logger.error('Error: You must specify one of --stdio or --sse')
    process.exit(1)
  }

  if (hasStdio) {
    const port = parseInt(process.env.PORT ?? argv.port?.toString() ?? '8000', 10)
    const baseUrl = process.env.BASE_URL ?? argv.baseUrl ?? ''
    const ssePath = process.env.SSE_PATH ?? argv.ssePath ?? '/sse'
    const messagePath = process.env.MESSAGE_PATH ?? argv.messagePath ?? '/message'
    await stdioToSse(argv.stdio!, port, baseUrl, ssePath, messagePath)
  }
  else {
    await sseToStdio(argv.sse!)
  }
}

main().catch(err => {
  logger.error('Fatal error:', err)
  process.exit(1)
})
