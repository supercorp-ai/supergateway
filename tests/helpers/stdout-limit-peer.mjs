import { createInterface } from 'node:readline'
import { once } from 'node:events'

process.on('SIGTERM', () => process.exit(0))
const report = async () => {
  const url = new URL('flood-start', process.env.FAULT_CONTROL)
  url.searchParams.set('pid', String(process.pid))
  await (await fetch(url)).text()
}
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  if (request.id === undefined) continue
  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'stdout-limit', version: String(process.pid) },
    })
  } else if (request.params?.name === 'flood') {
    await report()
    const chunk = Buffer.alloc(64 * 1024, 120)
    for (let i = 0; i < 8192; i++) {
      if (!process.stdout.write(chunk)) await once(process.stdout, 'drain')
    }
  } else {
    send(request.id, {
      content: [
        {
          type: 'text',
          text:
            request.params?.name === 'large'
              ? 'x'.repeat(16 * 1024 * 1024 + 1)
              : String(process.pid),
        },
      ],
    })
  }
}
