// A server whose calls report progress with no params at all, which is no
// valid progress but must still reach the client like any notification.
import { createInterface } from 'node:readline'

const send = (message) => process.stdout.write(JSON.stringify(message) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'bare-progress-peer', version: '1' },
      },
    })
    return
  }
  send({ jsonrpc: '2.0', method: 'notifications/progress' })
  send({ jsonrpc: '2.0', id, result: { content: [] } })
})
