import { createInterface } from 'node:readline'

const control = process.env.LIFETIME_CONTROL
const report = async (kind, extra = {}) => {
  const url = new URL(kind, control)
  url.search = new URLSearchParams({ pid: String(process.pid), ...extra })
  return (await fetch(url)).text()
}
if (process.env.LIFETIME_IGNORE_TERM === '1') process.on('SIGTERM', () => {})
// Deliberately survives stdin EOF: ending the pipe alone is not proof of cleanup.
setInterval(() => {}, 60000)
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
async function handle(message) {
  if (!('id' in message)) {
    await report(
      message.method === 'notifications/test' ? 'delivered' : 'notification',
      { method: message.method },
    )
    return
  }
  if (message.method === 'initialize') {
    if (process.env.LIFETIME_INIT_HOLD === '1')
      await report('hold', { phase: 'initialize' })
    send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'lifetime-peer', version: String(process.pid) },
      },
    })
    return
  }
  if (message.params?.name === 'hold') {
    await report('hold', { id: String(message.id) })
    // Observable work completes even if the HTTP client has disconnected.
    await report('completed', { id: String(message.id) })
  }
  if (message.params?.name === 'error') {
    send({
      id: message.id,
      error: { code: -32042, message: String(process.pid) },
    })
    return
  }
  send({
    id: message.id,
    result: {
      content: [
        { type: 'text', text: String(process.pid) },
        ...(message.params?.name === 'large'
          ? [{ type: 'text', text: 'x'.repeat(512 * 1024) }]
          : []),
      ],
    },
  })
}
for await (const line of createInterface({ input: process.stdin })) {
  void handle(JSON.parse(line)).catch((error) => {
    process.stderr.write(String(error) + '\n')
    process.exit(19)
  })
}
