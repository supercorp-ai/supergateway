#!/usr/bin/env node
/**
 * index.ts
 *
 * Run MCP stdio servers over SSE or vice versa
 *
 * Usage:
 *   # stdio -> SSE
 *   npx -y supergateway --stdio "npx -y @modelcontextprotocol/server-filesystem /some/folder" \
 *                       --port 8000 --baseUrl http://localhost:8000 --ssePath /sse --messagePath /message
 *
 *   # SSE -> stdio
 *   npx -y supergateway --sse "https://mcp-server.superinterface.app"
 */
// import { instrumentApp } from './instrumentation/index.js' // This will initialize the instrumentation
// instrumentApp().catch(err => {
//   logger.error('Fatal error:', err)
//   process.exit(1)
// })
import { logger } from './logger/index.js';
import express from 'express';
import { spawn } from 'child_process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { fileURLToPath } from 'url';
import { z } from 'zod';
import { join, dirname } from 'path';
import { readFileSync } from 'fs';
import { WebSocketServerTransport } from './server/websocket-transport.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
function getVersion() {
    try {
        const packageJsonPath = join(__dirname, '../package.json');
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
        return packageJson.version || '1.0.0';
    }
    catch (err) {
        logger.error('Unable to retrieve version:', err);
        return 'unknown';
    }
}
const webSocketToSse = async (sseUrl, port) => {
    logger.info('Starting...');
    logger.info(`  - port: ${port}`);
    logger.info(`  - sse: ${sseUrl}`);
    let wsTransport = null;
    // Cleanup function
    const cleanup = () => {
        if (wsTransport) {
            wsTransport.close().catch((error) => {
                logger.error('Error stopping WebSocket server:', error);
            });
        }
    };
    // Handle process termination
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    try {
        // Create and start WebSocket server
        wsTransport = new WebSocketServerTransport(port);
        await wsTransport.start();
        const server = new Server({ name: 'supergateway', version: getVersion() }, { capabilities: {} });
        await server.connect(wsTransport);
        const sseTransport = new SSEClientTransport(new URL(sseUrl));
        const client = new Client({ name: 'supergateway', version: getVersion() }, { capabilities: {} });
        sseTransport.onerror = (error) => {
            logger.error(`SSE error: ${error.message}`);
        };
        sseTransport.onclose = () => {
            logger.error('SSE connection closed');
            process.exit(1);
        };
        const wrapResponse = (req, payload) => ({
            jsonrpc: req.jsonrpc || '2.0',
            id: req.id,
            ...payload,
        });
        wsTransport.onmessage = async (msg) => {
            const isRequest = 'method' in msg && 'id' in msg;
            if (isRequest) {
                logger.info('WebSocket → SSE:', msg);
                const req = msg;
                let result;
                try {
                    result = await client.request(req, z.any());
                }
                catch (err) {
                    logger.error(`Request error: ${err}`);
                    const errorCode = err && typeof err === 'object' && 'code' in err
                        ? err.code
                        : -32000;
                    let errorMsg = err && typeof err === 'object' && 'message' in err
                        ? err.message
                        : 'Internal error';
                    // Remove the prefix if it is already present.
                    const prefix = `MCP error ${errorCode}:`;
                    if (errorMsg.startsWith(prefix)) {
                        errorMsg = errorMsg.slice(prefix.length).trim();
                    }
                    const errorResp = wrapResponse(req, {
                        error: {
                            code: errorCode,
                            message: errorMsg,
                        },
                    });
                    return errorResp;
                }
                const response = wrapResponse(req, result.hasOwnProperty('error')
                    ? { error: { ...result.error } }
                    : { result: { ...result } });
                logger.info(`${msg.method} → ${response.id}`);
                return response;
            }
            else {
                logger.info(`${msg.jsonrpc}`);
                return msg;
            }
        };
        client.onclose = () => {
            logger.error('SSE connection closed');
            process.exit(1);
        };
        await client.connect(sseTransport);
        logger.info('Connected to SSE server');
        wsTransport.onclose = () => {
            logger.info('WebSocket connection closed');
            process.exit(1);
        };
    }
    catch (error) {
        if (error instanceof Error) {
            logger.error(`Failed to start: ${error.message}`);
        }
        else {
            logger.error('Failed to start with unknown error');
        }
        cleanup();
        process.exit(1);
    }
};
const stdioToWebSocket = async (stdioCmd, port) => {
    logger.info('Starting...');
    logger.info(`  - port: ${port}`);
    logger.info(`  - stdio: ${stdioCmd}`);
    let wsTransport = null;
    let child = null;
    // Cleanup function
    const cleanup = () => {
        if (wsTransport) {
            wsTransport.close().catch(err => {
                logger.error('Error stopping WebSocket server:', err);
            });
        }
        if (child) {
            child.kill();
        }
    };
    // Handle process termination
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    try {
        child = spawn(stdioCmd, { shell: true });
        child.on('exit', (code, signal) => {
            logger.error(`Child exited: code=${code}, signal=${signal}`);
            cleanup();
            process.exit(code ?? 1);
        });
        const server = new Server({ name: 'supergateway', version: getVersion() }, { capabilities: {} });
        // Create and start WebSocket server
        wsTransport = new WebSocketServerTransport(port);
        await server.connect(wsTransport);
        wsTransport.onmessage = (msg) => {
            const line = JSON.stringify(msg);
            logger.info(`WebSocket → Child: ${line}`);
            child.stdin.write(line + '\n');
        };
        wsTransport.onclose = () => {
            logger.info('WebSocket connection closed');
        };
        wsTransport.onerror = err => {
            logger.error('WebSocket error:', err);
        };
        // Handle child process output
        let buffer = '';
        child.stdout.on('data', (chunk) => {
            buffer += chunk.toString('utf8');
            const lines = buffer.split(/\r?\n/);
            buffer = lines.pop() ?? '';
            lines.forEach(line => {
                if (!line.trim())
                    return;
                try {
                    const jsonMsg = JSON.parse(line);
                    logger.info('Child → WebSocket:', jsonMsg);
                    wsTransport?.send(jsonMsg).catch(err => {
                        logger.error('Failed to send message:', err);
                    });
                }
                catch {
                    logger.error(`Child non-JSON: ${line}`);
                }
            });
        });
        child.stderr.on('data', (chunk) => {
            logger.info(`Child stderr: ${chunk.toString('utf8')}`);
        });
        // Simple health check endpoint
        const app = express();
        app.get("/health", (req, res) => {
            res.send("OK");
        });
        app.listen(port + 1, () => {
            logger.info(`Health check endpoint listening on port ${port + 1}`);
            logger.info(`WebSocket endpoint: ws://localhost:${port}`);
        });
    }
    catch (err) {
        logger.error(`Failed to start: ${err.message}`);
        cleanup();
        process.exit(1);
    }
};
const main = async () => {
    const argv = yargs(hideBin(process.argv))
        .option('stdio', {
        type: 'string',
        description: 'Command to run an MCP server over Stdio'
    })
        .option('sse', {
        type: 'string',
        description: 'URL of an MCP server to connect to over SSE'
    })
        .option('port', {
        type: 'number',
        default: 8000,
        description: 'Port to run WebSocket server on'
    })
        .help()
        .parseSync();
    const port = parseInt(process.env.PORT ?? argv.port?.toString() ?? '8000', 10);
    if (argv.stdio) {
        await stdioToWebSocket(argv.stdio, port);
    }
    else if (argv.sse) {
        await webSocketToSse(argv.sse, port);
    }
    else {
        logger.error('No stdio or sse option provided');
        process.exit(1);
    }
};
main().catch(err => {
    logger.error('Fatal error:', err);
    process.exit(1);
});
