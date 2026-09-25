import {
  Transport,
  TransportSendOptions,
} from '@modelcontextprotocol/sdk/shared/transport.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import { v4 as uuidv4 } from 'uuid'
import { WebSocket, WebSocketServer } from 'ws'
import { Server } from 'http'

// The id a client sent, encoded by onmessage as JSON. The fallback keeps a
// non-JSON suffix as the string it was.
const decodeId = (raw: string): string | number => {
  try {
    const id = JSON.parse(raw)
    if (typeof id === 'string' || typeof id === 'number') return id
  } catch {
    // not JSON
  }
  return raw
}

export class WebSocketServerTransport implements Transport {
  private wss!: WebSocketServer
  private clients: Map<string, WebSocket> = new Map()

  onclose?: () => void
  onerror?: (err: Error) => void
  private messageHandler?: (msg: JSONRPCMessage, clientId: string) => void
  onconnection?: (clientId: string) => void
  ondisconnection?: (clientId: string) => void

  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this.messageHandler = handler
      ? (msg, clientId) => {
          // @ts-ignore
          if (msg.id === undefined) {
            console.log('Broadcast message:', msg)
            return handler(msg)
          }
          // The original id is JSON-encoded so send() can restore it with its
          // type: JSON-RPC allows string ids, not just numbers.
          // @ts-ignore
          return handler({
            ...msg,
            // @ts-ignore
            id: clientId + ':' + JSON.stringify(msg.id),
          })
        }
      : undefined
  }

  constructor({ path, server }: { path: string; server: Server }) {
    this.wss = new WebSocketServer({
      path,
      server,
    })
  }

  async start(): Promise<void> {
    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = uuidv4()
      this.clients.set(clientId, ws)
      this.onconnection?.(clientId)

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString())
          this.messageHandler?.(msg, clientId)
        } catch (err) {
          this.onerror?.(new Error(`Failed to parse message: ${err}`))
        }
      })

      ws.on('close', () => {
        this.clients.delete(clientId)
        this.ondisconnection?.(clientId)
      })

      ws.on('error', (err: Error) => {
        this.onerror?.(err)
      })
    })
  }

  async send(
    msg: JSONRPCMessage,
    options?: TransportSendOptions | string,
  ): Promise<void> {
    // decide if they passed a raw clientId (legacy) or options object
    const clientId = typeof options === 'string' ? options : undefined

    // if your protocol mangles IDs to include clientId, strip it off
    const separator = clientId?.indexOf(':') ?? -1
    const cId = separator === -1 ? clientId : clientId!.slice(0, separator)
    if (separator !== -1) {
      // @ts-ignore
      msg.id = decodeId(clientId!.slice(separator + 1))
    }

    const payload = JSON.stringify(msg)

    if (cId) {
      // send only to the one client
      const ws = this.clients.get(cId)
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(payload)
      } else {
        this.clients.delete(cId)
        this.ondisconnection?.(cId)
      }
    } else {
      // broadcast to everyone
      for (const [id, ws] of this.clients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(payload)
        } else {
          this.clients.delete(id)
          this.ondisconnection?.(id)
        }
      }
    }
  }

  async broadcast(msg: JSONRPCMessage): Promise<void> {
    return this.send(msg)
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
