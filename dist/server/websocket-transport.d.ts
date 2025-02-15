import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
/**
 * Server transport for WebSocket: this will create a WebSocket server that clients can connect to.
 */
export declare class WebSocketServerTransport implements Transport {
    private port;
    private wss;
    private clients;
    private clientIdCounter;
    onclose?: () => void;
    onerror?: (err: Error) => void;
    private messageHandler?;
    onconnection?: (clientId: string) => void;
    ondisconnection?: (clientId: string) => void;
    set onmessage(handler: ((message: JSONRPCMessage) => void) | undefined);
    constructor(port: number);
    start(): Promise<void>;
    send(msg: JSONRPCMessage, clientId?: string): Promise<void>;
    broadcast(msg: JSONRPCMessage): Promise<void>;
    close(): Promise<void>;
}
