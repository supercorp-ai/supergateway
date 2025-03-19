import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import { WebSocket, WebSocketServer } from "ws";
const SUBPROTOCOL = "mcp";

/**
 * Server transport for WebSocket: this will create a WebSocket server that clients can connect to.
 */
export class WebSocketServerTransport implements Transport {
  private host: string;
  private port: number;
  private path: string;
  private wss!: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();

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

  constructor(host: string, port: number, path: string, enableCors: boolean) {
    this.host = host || "0.0.0.0";
    this.port = port || 8080;
    this.path = path || "/ws";
    this.wss = new WebSocketServer({ host: this.host, port: this.port, path: this.path });
    if (enableCors) {
      this.wss.on("upgrade", (request, socket, head) => {
        if (request.headers.origin) {
          const origin = request.headers.origin;
          if (origin.includes("localhost") || origin.includes("127.0.0.1")) {
            socket.write("HTTP/1.1 200 OK\r\n" +
              "Access-Control-Allow-Origin: " + origin + "\r\n" +
              "Access-Control-Allow-Credentials: true\r\n" +
              "Connection: keep-alive\r\n" +
              "Content-Length: 0\r\n" +
              "Keep-Alive: timeout=5\r\n" +
              "Content-Type: text/plain\r\n" +
              "\r\n");
          }
        }
      })
    }
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
      });

      ws.on("error", (err: Error) => {
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