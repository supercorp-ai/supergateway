// A peer that reports how it was started: its arguments, its working
// directory and two environment variables, as JSON in its initialize result's
// `instructions`. Answers any other request with an empty result.
import { createInterface } from 'node:readline'

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (!('id' in message) || !message.method) return
  const result =
    message.method === 'initialize'
      ? {
          protocolVersion: message.params.protocolVersion,
          capabilities: {},
          serverInfo: { name: 'env-peer', version: '1.0.0' },
          instructions: JSON.stringify({
            argv: process.argv.slice(2),
            cwd: process.cwd(),
            value: process.env.ENV_PEER_VALUE ?? null,
            inherited: process.env.ENV_PEER_INHERITED ?? null,
          }),
        }
      : {}
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n',
  )
})
