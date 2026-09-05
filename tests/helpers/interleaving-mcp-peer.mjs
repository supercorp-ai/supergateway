// An external JSON-RPC peer used to exercise message ordering at the wire
// boundary. Notifications may arrive before a requested response.
import { createInterface } from 'node:readline'

const write = (message) => process.stdout.write(JSON.stringify(message) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (!('id' in message)) continue
  if (message.method === 'initialize') {
    if (process.argv.includes('--reject-initialize')) {
      write({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32603, message: 'Initialization unavailable' },
      })
      continue
    }
    write({
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', data: 'initializing' },
    })
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'interleaving-peer', version: '1.0.0' },
      },
    })
  } else if (message.method === 'tools/list') {
    if (process.argv.includes('--stale-response')) {
      write({ jsonrpc: '2.0', id: 'stale-peer-request', result: {} })
    }
    write({ jsonrpc: '2.0', id: message.id, result: { tools: [] } })
  } else {
    write({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: 'Method not found' },
    })
  }
}
