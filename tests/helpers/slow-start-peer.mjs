// A server that takes a while to start, like a cold npx or uvx install: it
// reads nothing for the given number of milliseconds (stdin waits in the pipe),
// then answers initialize and any request with its own process id, so a test
// can tell which process served a client.
import { createInterface } from 'node:readline'

const startup = Number(process.argv[2] ?? 1000)
const reply = (message) => process.stdout.write(JSON.stringify(message) + '\n')

setTimeout(() => {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line)
    if (!('id' in message) || !message.method) return
    reply({
      jsonrpc: '2.0',
      id: message.id,
      result:
        message.method === 'initialize'
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: {
                name: 'slow-start-peer',
                version: String(process.pid),
              },
            }
          : { content: [{ type: 'text', text: `pid ${process.pid}` }] },
    })
  })
}, startup)
