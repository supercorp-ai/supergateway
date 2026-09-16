// Accept the public handshake but crash on the gateway's per-request handshake.
import { createInterface } from 'node:readline'
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  if (message.method !== 'initialize') continue
  if (message.params.clientInfo.name === 'supergateway') process.exit(17)
  process.stdout.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'exit-init-peer', version: '1' },
      },
    }) + '\n',
    () => {
      if (process.argv[2] === 'reply-exit') process.exit(0)
    },
  )
}
