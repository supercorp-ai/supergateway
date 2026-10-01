// Answers initialize, then every request with an application error (code 42).
import { createInterface } from 'node:readline'
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (!('id' in m) || !m.method) return
  const reply =
    m.method === 'initialize'
      ? {
          result: {
            protocolVersion: m.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'app-error', version: '1' },
          },
        }
      : {
          error: {
            code: 42,
            message: 'quota exceeded',
            data: { retryAfter: 5 },
          },
        }
  process.stdout.write(
    JSON.stringify({ jsonrpc: '2.0', id: m.id, ...reply }) + '\n',
  )
})
