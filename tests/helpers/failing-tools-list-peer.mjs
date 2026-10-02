// A modern (2026-07-28) stdio peer whose tools/list always fails with a
// JSON-RPC error, while tools/call itself would succeed. The gateway looks a
// called tool's schema up with tools/list before forwarding the call.
import { createInterface } from 'node:readline'

const write = (message) => process.stdout.write(JSON.stringify(message) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line)
  if (id === undefined) continue
  if (method === 'tools/list')
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: 'tool listing unavailable' },
    })
  else if (method === 'tools/call')
    write({
      jsonrpc: '2.0',
      id,
      result: {
        resultType: 'complete',
        content: [{ type: 'text', text: 'called' }],
      },
    })
  else
    write({
      jsonrpc: '2.0',
      id,
      error: { code: -32601, message: 'Method not found' },
    })
}
