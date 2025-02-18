import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import { WebSocket, WebSocketServer } from "ws";
const SUBPROTOCOL = "mcp";

/**
 * Server transport for WebSocket: this will create a WebSocket server that clients can connect to.
 */
export class WebSocketServerTransport implements Transport {
  private port: number;
  private wss!: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();
  private clientIdCounter = 0;

  onclose?: () => void;
  onerror?: (err: Error) => void;
  private messageHandler?: (msg: JSONRPCMessage, clientId: string) => void;
  onconnection?: (clientId: string) => void;
  ondisconnection?: (clientId: string) => void;

  set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined) {
    this.messageHandler = handler ? (msg, clientId) => {
      // @ts-ignore
      if (msg.id === undefined) {
        console.log("Broadcast message:", msg);
        return handler(msg);
      }
      // @ts-ignore
      return handler({
        ...msg,
        // @ts-ignore
        id: clientId + ":" + msg.id
      })
    } : undefined;
  }

  constructor(port: number) {
    this.port = port;
    this.wss = new WebSocketServer({ port: this.port });
  }

  async start(): Promise<void> {
    this.wss.on("connection", (ws: WebSocket) => {
      const clientId = uuidv4();
      this.clients.set(clientId, ws);
      this.onconnection?.(clientId);

      ws.on("message", (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          this.messageHandler?.(msg, clientId);
        } catch (err) {
          this.onerror?.(new Error(`Failed to parse message: ${err}`));
        }
      });

      ws.on("close", () => {
        this.clients.delete(clientId);
        this.ondisconnection?.(clientId);
        if (this.clients.size === 0) {
          this.onclose?.();
        }
      });

      ws.on("error", (err) => {
        this.onerror?.(err);
      });
    });
  }

  async send(msg: JSONRPCMessage, clientId?: string): Promise<void> {
    const [cId, msgId] = clientId?.split(":") ?? [];
    // @ts-ignore
    msg.id = parseInt(msgId);
    const data = JSON.stringify(msg);
    const deadClients: string[] = [];

    if (cId) {
      // Send to specific client
      const client = this.clients.get(cId);
      if (client?.readyState === WebSocket.OPEN) {
        client.send(data);
      } else {
        this.clients.delete(cId);
        this.ondisconnection?.(cId);
      }
    } 
    
    for (const [id, client] of this.clients.entries()) {
      if (client.readyState !== WebSocket.OPEN) {
        deadClients.push(id);
      }
    }
    // Cleanup dead clients
    deadClients.forEach((id) => {
      this.clients.delete(id);
      this.ondisconnection?.(id);
    });
  }

  async broadcast(msg: JSONRPCMessage): Promise<void> {
    return this.send(msg);
  }

  async close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => {
        this.clients.clear();
        resolve();
      });
    });
  }
}
