// A peer that answers on stdout in deliberately awkward pieces.
//
// Every other peer in this suite writes `JSON.stringify(msg) + '\n'` in one
// call, so the gateways' stdout buffers — four identical copies of
// accumulate/split/keep-the-tail — are never exercised for the thing they
// exist to do. A real child hits this constantly: a large tools/list result is
// split by the OS pipe buffer, and the halves arrive as separate 'data' events.
//
// CHUNK_PLAN is a JSON array of arrays of byte counts, one plan per reply,
// reused cyclically. A short delay between pieces stops Node coalescing them
// back into a single write, which would quietly defeat the whole test.
import { setTimeout as delay } from 'node:timers/promises'

const plans = JSON.parse(process.env.CHUNK_PLAN ?? '[[65536]]')
let answered = 0
let buffer = ''
let queue = Promise.resolve()

const write = async (text, sizes) => {
  let at = 0
  let step = 0
  while (at < text.length) {
    const size = Math.max(1, sizes[step % sizes.length])
    process.stdout.write(text.slice(at, at + size))
    at += size
    step += 1
    if (at < text.length) await delay(3)
  }
}

process.stdin.setEncoding('utf8').on('data', (chunk) => {
  buffer += chunk
  const lines = buffer.split(/\r?\n/)
  buffer = lines.pop() ?? ''
  for (const line of lines) {
    if (!line.trim()) continue
    let request
    try {
      request = JSON.parse(line)
    } catch {
      continue
    }
    if (request.id === undefined) continue
    const plan = plans[answered % plans.length]
    answered += 1
    const reply = {
      jsonrpc: '2.0',
      id: request.id,
      // Padding so there is something substantial to cut up, and a marker the
      // test can check survived intact rather than merely parsing.
      result: { echo: request.method, pad: 'x'.repeat(120) },
    }
    queue = queue.then(() => write(JSON.stringify(reply) + '\n', plan))
  }
})
