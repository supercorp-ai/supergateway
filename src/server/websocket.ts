import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { v4 as uuidv4 } from 'uuid'
import { WebSocket, WebSocketServer } from 'ws'
import { Server } from 'http'

/**
 * The WebSocket endpoint: one entry per connected client, messages passed
 * through unchanged and addressed by client.
 *
 * It used to be a single SDK transport shared by every client of one child. It
 * told clients apart by rewriting each request id to `<clientId>:<id>` and
 * broadcast everything else, so one client received another's log and
 * progress notifications, and could be asked to answer another's sampling
 * request. The gateway now gives each connection its own child (as SSE does
 * since #221), and nothing here needs to know which request came from whom.
 */
export class WebSocketServerTransport {
  private readonly wss: WebSocketServer
  private readonly clients = new Map<string, WebSocket>()

  constructor(
    { path, server }: { path: string; server: Server },
    private readonly handlers: {
      onconnection: (clientId: string) => void
      onmessage: (message: JSONRPCMessage, clientId: string) => void
      ondisconnection: (clientId: string) => void
      onerror: (err: Error) => void
    },
  ) {
    this.wss = new WebSocketServer({ path, server })
  }

  start(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = uuidv4()
      this.clients.set(clientId, ws)
      this.handlers.onconnection(clientId)

      ws.on('message', (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString())
          this.handlers.onmessage(message, clientId)
        } catch (err) {
          this.handlers.onerror(new Error(`Failed to parse message: ${err}`))
        }
      })

      ws.on('close', () => {
        this.clients.delete(clientId)
        this.handlers.ondisconnection(clientId)
      })

      ws.on('error', (err: Error) => {
        this.handlers.onerror(err)
      })
    })
  }

  /**
   * Send to one client. A client that is gone, or closing, is skipped: its
   * `close` event removes it and reports the disconnection.
   */
  send(message: JSONRPCMessage, clientId: string): void {
    const ws = this.clients.get(clientId)
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }

  /** End one client's connection, e.g. when its child exits. */
  disconnect(clientId: string, reason: string): void {
    // 1011: the server hit a condition that stopped it fulfilling the request.
    this.clients.get(clientId)?.close(1011, reason)
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.clients.clear()
        resolve()
      })
    })
  }
}
