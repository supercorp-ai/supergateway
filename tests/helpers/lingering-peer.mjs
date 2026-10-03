// A server that answers initialize and lists no tools, and does not exit when
// its stdin closes: only a signal stops it. A gateway that leaves its servers
// to notice it has gone would leave this one running.
import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// Where to leave its pid, so a test can see whether it was stopped.
writeFileSync(process.argv[2], String(process.pid))

setInterval(() => {}, 1 << 30)
createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, method, params } = JSON.parse(line)
  if (id === undefined) return
  const result =
    method === 'initialize'
      ? {
          protocolVersion: params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'lingering-peer', version: '1' },
        }
      : method === 'tools/list'
        ? { tools: [] }
        : {}
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
})
