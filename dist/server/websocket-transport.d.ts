import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
/**
 * Server transport for WebSocket: this will create a WebSocket server that clients can connect to.
 */
export declare class WebSocketServerTransport implements Transport {
    private _server?;
    private _socket?;
    private _port;
    private _isStarting;
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: JSONRPCMessage) => void;
    constructor(port: number);
    start(): Promise<void>;
    close(): Promise<void>;
    send(message: JSONRPCMessage): Promise<void>;
}
