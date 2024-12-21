#!/usr/bin/env node
/**
 * index.ts
 *
 * Use stdio MCP servers over SSE with one command
 *
 * Usage:
 *   npx -y supergateway --port 8000 \
 *       --stdio "npx -y @modelcontextprotocol/server-filesystem /some/folder"
 */

import express from 'express'
import bodyParser from 'body-parser'
import { spawn, ChildProcessWithoutNullStreams } from 'child_process'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('port', {
      type: 'number',
      default: 8000,
      description: 'Port to run on (default: 8000)'
    })
    .option('stdio', {
      type: 'string',
      demandOption: true,
      description: 'Command that runs an MCP server over stdio'
    })
    .help()
    .parseSync()

  const PORT = argv.port
  const STDIO_CMD = argv.stdio

  console.log('[supergateway] Starting...')
  console.log(`[supergateway]  - Port: ${PORT}`)
  console.log(`[supergateway]  - stdio: ${STDIO_CMD}`)

  // 1. Spawn the child MCP server
  const child: ChildProcessWithoutNullStreams = spawn(STDIO_CMD, { shell: true })
  child.on('exit', (code, signal) => {
    console.error(`[supergateway] Child process exited with code=${code}, signal=${signal}`)
  })

  // 2. Create a simple MCP Server that forwards messages to/from the child
  const server = new Server(
    { name: 'stdio-bridge', version: '1.0.0' },
    { capabilities: {} }
  )

  let sseTransport: SSEServerTransport | undefined

  // 3. Set up Express
  const app = express()

  // Skip bodyParser for /message
  app.use((req, res, next) => {
    if (req.path === '/message') {
      return next()
    }
    return bodyParser.json()(req, res, next)
  })

  // GET /sse => SSE endpoint
  app.get('/sse', async (req, res) => {
    console.log(`[supergateway] New SSE connection from ${req.ip}`)
    sseTransport = new SSEServerTransport('/message', res)
    await server.connect(sseTransport)

    // SSE -> Child
    sseTransport.onmessage = (msg: JSONRPCMessage) => {
      const line = JSON.stringify(msg)
      console.log('[supergateway] SSE -> Child:', line)
      child.stdin.write(line + '\n')
    }

    sseTransport.onclose = () => {
      console.log('[supergateway] SSE connection closed.')
    }

    sseTransport.onerror = err => {
      console.error('[supergateway] SSE transport error:', err)
    }
  })

  // POST /message => handle JSON-RPC from SSE
  app.post('/message', async (req, res) => {
    if (sseTransport?.handlePostMessage) {
      console.log('[supergateway] POST /message -> SSE transport')
      await sseTransport.handlePostMessage(req, res)
    } else {
      res.status(503).send('No SSE connection active')
    }
  })

  // 4. Child -> SSE
  child.stdout.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    for (const line of text.split(/\r?\n/g)) {
      if (!line.trim()) continue
      try {
        const jsonMsg = JSON.parse(line)
        console.log('[supergateway] Child -> SSE:', jsonMsg)
        sseTransport?.send(jsonMsg)
      } catch {
        console.error('[supergateway] Child produced non-JSON line:', line)
      }
    }
  })

  child.stderr.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    console.error('[supergateway] [child stderr]', text)
  })

  // 5. Listen
  app.listen(PORT, () => {
    console.log(`[supergateway] Listening on port ${PORT}`)
    console.log(`  SSE endpoint:   http://localhost:${PORT}/sse`)
    console.log(`  POST messages:  http://localhost:${PORT}/message`)
  })
}

main().catch(err => {
  console.error('[supergateway] Fatal error:', err)
  process.exit(1)
})