import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage, JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { WebSocket, WebSocketServer } from "ws";
import { logger } from "../logger/index.js";
const SUBPROTOCOL = "mcp";

/**
 * Server transport for WebSocket: this will create a WebSocket server that clients can connect to.
 */
export class WebSocketServerTransport implements Transport {
  private _server?: WebSocketServer;
  private _socket?: WebSocket;
  private _port: number;
  private _isStarting: boolean = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(port: number) {
    this._port = port;
  }

  async start(): Promise<void> {
    // Prevent concurrent starts
    if (this._isStarting) {
      throw new Error("WebSocket server is already starting");
    }

    // If server exists, close it first
    if (this._server) {
      await this.close();
    }

    this._isStarting = true;

    try {
      return await new Promise((resolve, reject) => {
        this._server = new WebSocketServer({ 
          port: this._port,
          handleProtocols: (protocols) => {
            return protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false;
          }
        });

        this._server.on('error', (error) => {
          this._isStarting = false;
          reject(error);
          this.onerror?.(error);
        });

        this._server.on('connection', (socket, request) => {
          if (this._socket) {
            // Only allow one connection at a time
            socket.close();
            return;
          }

          this._socket = socket;

          socket.on('error', (error) => {
            this.onerror?.(error);
          });

          socket.on('close', () => {
            this._socket = undefined;
            this.onclose?.();
          });

          socket.on('message', (data) => {
            let message: JSONRPCMessage;
            try {
              message = JSONRPCMessageSchema.parse(JSON.parse(data.toString()));
            } catch (error) {
              this.onerror?.(error as Error);
              return;
            }

            this.onmessage?.(message);
          });

          this._isStarting = false;
          resolve();
        });

        // Add timeout to prevent hanging if no connection is made
        setTimeout(() => {
          if (this._isStarting) {
            this._isStarting = false;
            resolve(); // Resolve anyway after server is listening
          }
        }, 1000);
      });
    } catch (error) {
      this._isStarting = false;
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this._socket) {
      this._socket.close();
      this._socket = undefined;
    }
    
    if (this._server) {
      await new Promise<void>((resolve, reject) => {
        this._server?.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      this._server = undefined;
    }
    
    this._isStarting = false;
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this._socket) {
        reject(new Error("No client connected"));
        return;
      }

      this._socket.send(JSON.stringify(message), (error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }
}
