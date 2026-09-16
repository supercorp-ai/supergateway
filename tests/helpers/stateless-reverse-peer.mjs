// Deliberately requests client features even when none were advertised. Reuse
// the client's ID to verify that opposite request directions stay distinct.
import { createInterface } from 'node:readline'
const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
let capabilities
let pending
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === 'initialize') {
    capabilities = message.params.capabilities
    pending = message
    send({ jsonrpc: '2.0', id: message.id, method: 'roots/list' })
  } else if (message.method === 'tools/call') {
    pending = message
    send({
      jsonrpc: '2.0',
      id: message.id,
      method: message.params.arguments.method,
    })
  } else if ('id' in message && !('method' in message)) {
    const request = pending
    pending = undefined
    send({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: { requestId: request.id, capabilities } },
    })
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {}, logging: {} },
            serverInfo: { name: 'reverse-probe', version: '1.0.0' },
            instructions: JSON.stringify({ capabilities, reply: message }),
          }
        : {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ capabilities, reply: message }),
              },
            ],
          }
    send({ jsonrpc: '2.0', id: request.id, result })
  }
})
