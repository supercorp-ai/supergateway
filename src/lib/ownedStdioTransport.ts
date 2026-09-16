import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  parseJSONRPCMessage,
  type Transport,
  type JSONRPCMessage,
} from './modernSdk.js'
import type { Logger } from '../types.js'
import type { OwnedChildProcesses } from './ownedChildProcesses.js'

/** A request-owned pipe whose shutdown also reaps the child's descendants. */
export class OwnedStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private child?: ChildProcessWithoutNullStreams
  private stop?: () => Promise<void>
  private closed = false

  constructor(
    private readonly command: string,
    private readonly owner: OwnedChildProcesses,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    const child = spawn(this.command, this.owner.spawnOptions)
    this.child = child
    this.stop = this.owner.own(child)
    const fail = (error: Error) => {
      if (this.closed) return
      this.logger.error('MCP child failed:', error)
      this.onerror?.(error)
      void this.close()
    }
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stdout.on('end', () => fail(new Error('Child stdout closed')))
    child.on('exit', (code, signal) => {
      fail(new Error(`Child exited: code=${code}, signal=${signal}`))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      this.logger.error('Child stderr:', chunk.toString('utf8'))
    })
    let buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop()!
      for (const line of lines) {
        if (!line.trim()) continue
        let message: JSONRPCMessage
        try {
          message = parseJSONRPCMessage(JSON.parse(line))
        } catch {
          this.logger.error('Child non-JSON message:', line)
          continue
        }
        this.onmessage?.(message)
      }
    })
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed || !this.child) throw new Error('MCP child is closed')
    await new Promise<void>((resolve, reject) => {
      this.child!.stdin.write(JSON.stringify(message) + '\n', (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  async close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onclose?.()
    }
    await this.stop?.()
  }
}
