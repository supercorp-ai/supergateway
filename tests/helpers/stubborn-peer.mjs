// A server that does not exit when its stdin closes: only the gateway ending
// it stops it. Servers that exit on EOF hide a gateway that never stops them,
// so the cleanup tests use this one. It leaves a file named after its PID in
// CLEANUP_PIDS, for the test to check it is gone.
//
// It answers initialize, and server/discover for 2026-07-28. Tools: `ping`;
// `crash`, which exits without answering; `hang`, never answered; and
// `orphan`, which ends its parent, the wrapper, and goes on running.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

writeFileSync(join(process.env.CLEANUP_PIDS, `server-${process.pid}`), '')

setInterval(() => {}, 1 << 30)
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return
  const { id, method, params = {} } = JSON.parse(line)
  if (id === undefined) return
  const modern =
    params._meta?.['io.modelcontextprotocol/protocolVersion'] === '2026-07-28'
  const result = (value) =>
    send({
      id,
      result: {
        ...(modern
          ? { resultType: 'complete', ttlMs: 0, cacheScope: 'private' }
          : {}),
        ...value,
      },
    })
  if (method === 'initialize' || (modern && method === 'server/discover'))
    result({
      ...(modern
        ? { supportedVersions: ['2026-07-28'] }
        : { protocolVersion: params.protocolVersion ?? '2025-06-18' }),
      capabilities: { tools: {} },
      serverInfo: { name: 'stubborn-peer', version: String(process.pid) },
    })
  else if (method === 'tools/list')
    result({
      tools: ['ping', 'crash', 'hang', 'orphan'].map((name) => ({
        name,
        inputSchema: { type: 'object' },
      })),
    })
  else if (method === 'tools/call' && params.name === 'crash') process.exit(3)
  else if (method === 'tools/call' && params.name === 'hang') return
  // Its wrapper crashes; it runs on.
  else if (method === 'tools/call' && params.name === 'orphan')
    process.kill(process.ppid, 'SIGKILL')
  else if (method === 'tools/call')
    result({ content: [{ type: 'text', text: 'pong' }] })
  else send({ id, error: { code: -32601, message: 'Method not found' } })
})
