// Emit valid UTF-8 JSON bytes, with transport writes inside multibyte scalars.
// stdin uses streaming decoding; stdout deliberately leaves decoding to its reader.
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'

const text = 'ą€🙂漢'
let queue = Promise.resolve()
async function answer(request) {
  if (request.id === undefined) return
  const result =
    request.method === 'initialize'
      ? {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'utf8-boundary', version: '1.0.0' },
        }
      : { content: [{ type: 'text', text }] }
  const bytes = Buffer.from(
    JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n',
  )
  if (request.method === 'initialize' || process.env.SPLIT_UTF8 !== '1') {
    process.stdout.write(bytes)
    return
  }
  const start = bytes.indexOf(Buffer.from(text))
  process.stdout.write(bytes.subarray(0, start))
  for (let at = start; at < start + Buffer.byteLength(text); at++) {
    process.stdout.write(bytes.subarray(at, at + 1))
    await delay(30)
  }
  process.stdout.write(bytes.subarray(start + Buffer.byteLength(text)))
}
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  queue = queue.then(() => answer(request))
}
await queue
