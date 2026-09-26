// A peer that reports every message it receives on stderr, one line each, and
// answers any request with an empty result, so a test can see exactly what a
// gateway delivered to its child.
import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  const id = 'id' in message ? ` #${message.id}` : ''
  process.stderr.write(`RECEIVED ${message.method ?? 'reply'}${id}\n`)
  if (!('id' in message) || !message.method) return
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: {},
          serverInfo: { name: 'recording-peer', version: '1.0.0' },
        }
      : {}
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n',
  )
})
