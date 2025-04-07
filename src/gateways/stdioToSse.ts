import express from 'express'
import bodyParser from 'body-parser'
import cors from 'cors'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { Logger } from '../types.js'
import { getVersion } from '../lib/getVersion.js'
import { onSignals } from '../lib/onSignals.js'
import { parseHeaders } from '../lib/parseHeaders.js'

export interface StdioToSseArgs {
  stdioCmd: string
  port: number
  baseUrl: string
  ssePath: string
  messagePath: string
  logger: Logger
  enableCors: boolean
  healthEndpoints: string[]
  cliHeaders?: string[]
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

class ChildProcessPool {
  private maxConcurrency: number
  private activeProcesses: Set<ChildProcessWithoutNullStreams> = new Set()
  private idleProcesses: ChildProcessWithoutNullStreams[] = []
  private queue: Array<() => void> = []
  private logger: Logger

  constructor(
    private stdioCmd: string,
    maxConcurrency: number,
    logger: Logger,
    prefork: number = 0,
  ) {
    this.maxConcurrency = maxConcurrency
    this.logger = logger
    // 预创建子进程
    for (let i = 0; i < Math.min(prefork, maxConcurrency); i++) {
      this.idleProcesses.push(this.createChild())
    }
    logger.info(`Preforked ${prefork} child processes`)
  }

  async acquire(): Promise<ChildProcessWithoutNullStreams> {
    // 优先使用空闲进程
    if (this.idleProcesses.length > 0) {
      const child = this.idleProcesses.shift()!
      this.activeProcesses.add(child)
      this.logger.info(
        `Reusing child process, active: ${this.activeProcesses.size}`,
      )
      return child
    }

    if (this.activeProcesses.size < this.maxConcurrency) {
      const child = this.createChild()
      this.activeProcesses.add(child)
      this.logger.info(
        `New child created, active: ${this.activeProcesses.size}`,
      )
      return child
    }

    this.logger.info(
      `Waiting for available process (${this.queue.length} queued)`,
    )
    return new Promise((resolve) => {
      this.queue.push(() => {
        const child = this.idleProcesses.shift() || this.createChild()
        this.activeProcesses.add(child)
        resolve(child)
      })
    })
  }

  release(child: ChildProcessWithoutNullStreams) {
    // 检查进程是否存活
    if (child.exitCode === null && !child.killed) {
      this.activeProcesses.delete(child)
      this.idleProcesses.push(child)
      this.logger.info(
        `Process released to pool, active: ${this.activeProcesses.size}, idle: ${this.idleProcesses.length}`,
      )

      // 清空旧监听器和缓冲区
      child.stdout.removeAllListeners('data')
      child.stderr.removeAllListeners('data')
      child.removeAllListeners('exit')

      // 触发等待队列
      if (this.queue.length > 0) {
        const next = this.queue.shift()!
        next()
      }
    } else {
      this.logger.info('Cannot release exited process')
    }
  }

  private createChild(): ChildProcessWithoutNullStreams {
    const child = spawn(this.stdioCmd, { shell: true })

    child.stdin.on('error', (err) => {
      this.logger.error(`Child stdin error: ${err.message}`)
    })

    child.stderr.on('data', (data: Buffer) => {
      const errorOutput = data.toString('utf8').trim()
      this.logger.error(`Child stderr error: ${errorOutput}`)
    })

    child.on('exit', (code, signal) => {
      this.activeProcesses.delete(child)
      this.idleProcesses = this.idleProcesses.filter((p) => p !== child)
      this.logger.error(
        `Child exited, active: ${this.activeProcesses.size}, code=${code}`,
      )
      this.checkQueue()
    })

    child.on('error', (err) => {
      this.activeProcesses.delete(child)
      this.idleProcesses = this.idleProcesses.filter((p) => p !== child)
      this.logger.error(`Child error: ${err.message}`)
    })

    return child
  }

  private checkQueue() {
    if (this.queue.length > 0) {
      const next = this.queue.shift()!
      next()
    }
  }
}

export async function stdioToSse(args: StdioToSseArgs) {
  const {
    stdioCmd,
    port,
    baseUrl,
    ssePath,
    messagePath,
    logger,
    enableCors,
    healthEndpoints,
    cliHeaders = [],
  } = args

  const headers = parseHeaders(cliHeaders, logger)
  const prefork = parseInt(process.env.MCP_STDIO_PROCESS_PRE_FORK || '1', 10)
  const maxConcurrency = parseInt(process.env.MCP_STDIO_PROCESS_MAX || '10', 10)
  const pool = new ChildProcessPool(stdioCmd, maxConcurrency, logger, prefork)

  logger.info(`Starting with max concurrency: ${maxConcurrency}`)

  logger.info(
    `  - Headers: ${cliHeaders.length ? JSON.stringify(cliHeaders) : '(none)'}`,
  )
  logger.info(`  - port: ${port}`)
  logger.info(`  - stdio: ${stdioCmd}`)
  if (baseUrl) {
    logger.info(`  - baseUrl: ${baseUrl}`)
  }
  logger.info(`  - ssePath: ${ssePath}`)
  logger.info(`  - messagePath: ${messagePath}`)

  logger.info(`  - CORS enabled: ${enableCors}`)
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )

  onSignals({ logger })

  // const child: ChildProcessWithoutNullStreams = spawn(stdioCmd, { shell: true })
  // child.on('exit', (code, signal) => {
  //   logger.error(`Child exited: code=${code}, signal=${signal}`)
  //   process.exit(code ?? 1)
  // })

  // const server = new Server(
  //   { name: 'supergateway', version: getVersion() },
  //   { capabilities: {} },
  // )

  const sessions: Record<
    string,
    { transport: SSEServerTransport; response: express.Response }
  > = {}

  const app = express()

  if (enableCors) {
    app.use(cors())
  }

  app.use((req, res, next) => {
    if (req.path === messagePath) return next()
    return bodyParser.json()(req, res, next)
  })

  for (const ep of healthEndpoints) {
    app.get(ep, (_req, res) => {
      setResponseHeaders({
        res,
        headers,
      })
      res.send('ok')
    })
  }

  app.get(ssePath, async (req, res) => {
    logger.info(`New SSE connection from ${req.ip}`)

    setResponseHeaders({
      res,
      headers,
    })

    let child: ChildProcessWithoutNullStreams
    try {
      child = await pool.acquire()
    } catch (err) {
      logger.error('Failed to acquire child process:', err)
      res.status(503).send('Service unavailable')
      return
    }

    const sseTransport = new SSEServerTransport(`${baseUrl}${messagePath}`, res)
    const server = new Server(
      { name: 'supergateway', version: getVersion() },
      { capabilities: {} },
    )
    await server.connect(sseTransport)

    const sessionId = sseTransport.sessionId
    if (sessionId) {
      sessions[sessionId] = { transport: sseTransport, response: res }
    }
    let buffer = ''

    // 处理子进程输出，仅发送到当前会话
    const onStdoutData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      lines.forEach((line) => {
        if (!line.trim()) return
        try {
          const jsonMsg = JSON.parse(line)
          logger.info(`Child → SSE (session ${sessionId}) [JSON]:`, {
            parsed: jsonMsg,
            raw: line,
          })
          sseTransport.send(jsonMsg)
        } catch (err) {
          logger.error(`Child non-JSON: ${line}`, err)
        }
      })
    }

    child.stdout.on('data', onStdoutData)

    // 处理子进程退出
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      logger.error(
        `Child exited (session ${sessionId}): code=${code}, signal=${signal}`,
      )
      sseTransport.close()
    }

    child.on('exit', onExit)

    // 在客户端断开处理中
    req.on('close', () => {
      logger.info(`Client disconnected (session ${sessionId})`)
      delete sessions[sessionId]

      // 停止当前会话的数据处理
      child.stdout.off('data', onStdoutData)
      child.off('exit', onExit)

      // 安全写入reset命令, 重置子进程状态
      if (child.exitCode === null && !child.killed) {
        child.stdin.write(JSON.stringify({ method: 'reset' }) + '\n', (err) => {
          if (err) {
            logger.error(`Reset command write error: ${err.message}`)
          }
        })
      } else {
        logger.info('Child process already exited, skipping reset')
      }

      // 释放回进程池
      pool.release(child)
    })

    // 处理客户端消息
    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      logger.info(`SSE → Child (session ${sessionId}): ${JSON.stringify(msg)}`)
      child.stdin.write(JSON.stringify(msg) + '\n')
    }

    sseTransport.onclose = () => {
      logger.info(`SSE connection closed (session ${sessionId})`)
      if (sessionId && sessions[sessionId]) {
        delete sessions[sessionId]
      }
    }

    sseTransport.onerror = (err) => {
      logger.error(`SSE error (session ${sessionId}):`, err)
      delete sessions[sessionId]
    }
  })

  // @ts-ignore
  app.post(messagePath, async (req, res) => {
    const sessionId = req.query.sessionId as string

    setResponseHeaders({
      res,
      headers,
    })

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
}
