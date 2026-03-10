import express from 'express'
import cors, { type CorsOptions } from 'cors'
import { spawn } from 'child_process'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  JSONRPCMessage,
  isInitializeRequest,
} from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { serializeCorsOrigin } from '../lib/serializeCorsOrigin.js'

export interface StdioToStatefulStreamableHttpArgs {
  stdioCmd: string
  port: number
  streamableHttpPath: string
  logger: Logger
  corsOrigin: CorsOptions['origin']
  healthEndpoints: string[]
  headers: Record<string, string>
  headersPassthrough: string[]
}

const setResponseHeaders = ({
  res,
  headers,
}: {
  res: express.Response
  headers: Record<string, string>
}) =>
  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value)
  })

export async function stdioToStatefulStreamableHttp(
  args: StdioToStatefulStreamableHttpArgs,
) {
  const {
    stdioCmd,
    port,
    streamableHttpPath,
    logger,
    corsOrigin,
    healthEndpoints,
    headers,
    headersPassthrough,
  } = args

  logger.info(
    `  - Headers: ${Object.keys(headers).length ? JSON.stringify(headers) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  logger.info(`  - streamableHttpPath: ${streamableHttpPath}`)
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  const app = express()
  app.use(express.json())

  if (corsOrigin) {
    app.use(cors({ origin: corsOrigin, exposedHeaders: ['Mcp-Session-Id'] }))
  }

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({ res, headers })
      res.send('ok')
    })
  }

  const transports: Record<string, StreamableHTTPServerTransport> = {}

  app.post(streamableHttpPath, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined

    if (sessionId && transports[sessionId]) {
      const transport = transports[sessionId]
      await transport.handleRequest(req, res, req.body)
      return
    }

    if (!sessionId && isInitializeRequest(req.body)) {
      const server = new Server(
        { name: 'supergateway', version: getVersion() },
        { capabilities: {} },
      )

      let transport: StreamableHTTPServerTransport
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          transports[sid] = transport
          logger.info(`Session initialized: ${sid}`)
        },
      })

      await server.connect(transport)

      const passthroughEnv: Record<string, string> = {}
      for (const headerName of headersPassthrough) {
        const value = req.headers[headerName.toLowerCase()]
        if (value !== undefined) {
          const envKey = `HEADER_${headerName.toUpperCase().replace(/-/g, '_')}`
          passthroughEnv[envKey] = Array.isArray(value)
            ? value.join(', ')
            : value
        }
      }

      const child = spawn(stdioCmd, {
        shell: true,
        env: { ...process.env, ...passthroughEnv },
      })
      child.on('exit', (code, signal) => {
        logger.error(`Child exited: code=${code}, signal=${signal}`)
        transport.close()
      })

      let buffer = ''
      child.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() ?? ''
        lines.forEach((line) => {
          if (!line.trim()) return
          try {
            const jsonMsg = JSON.parse(line)
            logger.info(`Child → StreamableHttp: ${line}`)
            try {
              transport.send(jsonMsg)
            } catch (e) {
              logger.error('Failed to send to StreamableHttp', e)
            }
          } catch {
            logger.error(`Child non-JSON: ${line}`)
          }
        })
      })

      child.stderr.on('data', (chunk: Buffer) => {
        logger.error(`Child stderr: ${chunk.toString('utf8')}`)
      })

      transport.onmessage = (msg: JSONRPCMessage) => {
        logger.info(`StreamableHttp → Child: ${JSON.stringify(msg)}`)
        child.stdin.write(JSON.stringify(msg) + '\n')
      }

      transport.onclose = () => {
        const sid = transport.sessionId
        logger.info(`StreamableHttp connection closed (session ${sid})`)
        if (sid) delete transports[sid]
        child.kill()
      }

      transport.onerror = (err: Error) => {
        const sid = transport.sessionId
        logger.error(`StreamableHttp error (session ${sid}):`, err)
        if (sid) delete transports[sid]
        child.kill()
      }

      await transport.handleRequest(req, res, req.body)
      return
    }

    res.status(400).json({
      jsonrpc: '2.0',
      error: {
        code: -32000,
        message: 'Bad Request: No valid session ID provided',
      },
      id: null,
    })
  })

  const handleSessionRequest = async (
    req: express.Request,
    res: express.Response,
  ) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (!sessionId || !transports[sessionId]) {
      res.status(400).send('Invalid or missing session ID')
      return
    }
    await transports[sessionId].handleRequest(req, res)
  }

  app.get(streamableHttpPath, handleSessionRequest)
  app.delete(streamableHttpPath, handleSessionRequest)

  app.listen(port, () => {
    logger.info(`Listening on port ${port}`)
    logger.info(
      `StreamableHttp endpoint: http://localhost:${port}${streamableHttpPath}`,
    )
  })
}
