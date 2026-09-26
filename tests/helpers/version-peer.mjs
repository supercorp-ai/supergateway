// A peer that answers any request with the protocol version it was
// initialized with, so a test can see what a gateway negotiated on its behalf.
import { createInterface } from 'node:readline'
let negotiated = 'none'
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') {
    negotiated = m.params.protocolVersion
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: { name: 'v', version: '1' },
        },
      }) + '\n',
    )
  } else if ('id' in m && m.method)
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          content: [
            { type: 'text', text: 'child initialized with ' + negotiated },
          ],
        },
      }) + '\n',
    )
})
