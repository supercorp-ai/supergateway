// A peer that enforces the handshake the way the Python SDK does: until it has
// seen initialize and then notifications/initialized, it refuses every other
// request with -32602 "Invalid request parameters". Once initialized, it
// answers any request with who initialized it, with which protocol version, and
// how many initialize requests and initialized notifications it received.
import { createInterface } from 'node:readline'

let initializedBy
let version
let initializes = 0
let initializeds = 0

const reply = (message) => process.stdout.write(JSON.stringify(message) + '\n')

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    initializes++
    initializedBy = message.params.clientInfo.name
    version = message.params.protocolVersion
    reply({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'strict-init-peer', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'notifications/initialized') {
    initializeds++
    return
  }
  if (!('id' in message) || !message.method) return
  if (!initializeds) {
    reply({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32602, message: 'Invalid request parameters' },
    })
    return
  }
  reply({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      content: [
        {
          type: 'text',
          text: `initialized by ${initializedBy} with ${version}; initialize x${initializes}; initialized x${initializeds}`,
        },
      ],
    },
  })
})
