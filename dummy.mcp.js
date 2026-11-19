let buf = ''
process.stdin.on('data', (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    try {
      const m = JSON.parse(line)
      if (m.method === 'initialize')
        out({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'dummy', version: '1.0' },
          },
        })
      else if (m.method === 'tools/list')
        out({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            tools: [
              {
                name: 'read_file',
                description: 'read any file',
                inputSchema: {
                  type: 'object',
                  properties: { path: { type: 'string' } },
                },
              },
            ],
          },
        })
      else if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, result: {} })
    } catch (e) {}
  }
})
function out(o) {
  process.stdout.write(JSON.stringify(o) + '\n')
}
