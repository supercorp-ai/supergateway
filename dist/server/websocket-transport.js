import { WebSocket, WebSocketServer } from "ws";
const SUBPROTOCOL = "mcp";
/**
 * Server transport for WebSocket: this will create a WebSocket server that clients can connect to.
 */
export class WebSocketServerTransport {
    port;
    wss;
    clients = new Map();
    clientIdCounter = 0;
    onclose;
    onerror;
    messageHandler;
    onconnection;
    ondisconnection;
    set onmessage(handler) {
        this.messageHandler = handler ? (msg, _clientId) => handler(msg) : undefined;
    }
    constructor(port) {
        this.port = port;
        this.wss = new WebSocketServer({ port: this.port });
    }
    async start() {
        this.wss.on('connection', (ws) => {
            const clientId = `client_${++this.clientIdCounter}`;
            this.clients.set(clientId, ws);
            this.onconnection?.(clientId);
            ws.on('message', (data) => {
                try {
                    const msg = JSON.parse(data.toString());
                    this.messageHandler?.(msg, clientId);
                }
                catch (err) {
                    this.onerror?.(new Error(`Failed to parse message: ${err}`));
                }
            });
            ws.on('close', () => {
                this.clients.delete(clientId);
                this.ondisconnection?.(clientId);
                if (this.clients.size === 0) {
                    this.onclose?.();
                }
            });
            ws.on('error', (err) => {
                this.onerror?.(err);
            });
        });
    }
    async send(msg, clientId) {
        const data = JSON.stringify(msg);
        const deadClients = [];
        if (clientId) {
            // Send to specific client
            const client = this.clients.get(clientId);
            if (client?.readyState === WebSocket.OPEN) {
                client.send(data);
            }
            else {
                this.clients.delete(clientId);
                this.ondisconnection?.(clientId);
            }
        }
        else {
            // Broadcast to all clients
            for (const [id, client] of this.clients.entries()) {
                if (client.readyState === WebSocket.OPEN) {
                    client.send(data);
                }
                else {
                    deadClients.push(id);
                }
            }
        }
        // Cleanup dead clients
        deadClients.forEach(id => {
            this.clients.delete(id);
            this.ondisconnection?.(id);
        });
    }
    async broadcast(msg) {
        return this.send(msg);
    }
    async close() {
        return new Promise((resolve) => {
            this.wss.close(() => {
                this.clients.clear();
                resolve();
            });
        });
    }
}
