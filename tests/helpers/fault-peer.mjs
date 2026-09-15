// Protocol peer with observable barriers. It stays alive after stdin closes,
// as a real server with background work can, so EOF is not mistaken for reaping.
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { closeSync } from 'node:fs'

const control = process.env.FAULT_CONTROL
let calls = 0
setInterval(() => {}, 60000)
const send = (id, result) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
const report = async (kind, extra = {}) => {
  if (!control) return 'release'
  const url = new URL(kind, control)
  url.search = new URLSearchParams({
    pid: String(process.pid),
    ...extra,
  }).toString()
  return (await fetch(url)).text()
}
async function closeInput() {
  const closed = once(process.stdin, 'close')
  process.stdin.destroy()
  await closed
  // stdin.destroy() alone leaves fd 0 open on Node; close the OS pipe too.
  closeSync(0)
  await report('stdin-closed')
}
async function handle(request) {
  if (request.id === undefined) return
  if (request.method === 'initialize') {
    if (
      process.env.FAULT_INIT === '1' &&
      request.params.clientInfo.name === 'supergateway'
    )
      await closeInput()
    send(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fault-peer', version: String(process.pid) },
    })
    return
  }
  if (request.method === 'tools/list') {
    send(request.id, {
      tools: ['identity', 'closeInput', 'hold', 'burst'].map((name) => ({
        name,
        inputSchema: { type: 'object', properties: {} },
      })),
    })
    return
  }
  const name = request.params?.name
  if (name === 'closeInput') await closeInput()
  if (name === 'hold') {
    if (process.env.FAULT_LATE_TERM === '1') process.on('SIGTERM', () => {})
    const action = await report('hold', { id: String(request.id) })
    if (action === 'exit') process.exit(17)
  }
  if (name === 'burst') {
    const count = request.params.arguments?.count ?? 1024
    const data = 'x'.repeat(16384)
    await report('burst-start')
    for (let seq = 0; seq < count; seq++) {
      const line =
        JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', data, logger: String(seq) },
        }) + '\n'
      if (!process.stdout.write(line)) await once(process.stdout, 'drain')
    }
    await report('burst-done', { bytes: String(count * data.length) })
  }
  send(request.id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          pid: process.pid,
          wrapperPid: Number(process.env.FAULT_WRAPPER_PID ?? 0),
          calls: ++calls,
          name,
        }),
      },
    ],
  })
  if (name === 'hold') await report('held-reply')
}
for await (const line of createInterface({ input: process.stdin })) {
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(String(error) + '\n')
    process.exitCode = 19
  })
}
