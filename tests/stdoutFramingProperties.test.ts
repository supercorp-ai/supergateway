import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * Every gateway accumulates the child's stdout and splits it on newlines:
 *
 *   buffer += chunk
 *   const lines = buffer.split(/\r?\n/)
 *   buffer = lines.pop() ?? ''
 *
 * The same four lines appear in stdioToSse, both Streamable HTTP gateways and
 * stdioToWs. They exist because a write by the child is not a message: the OS
 * pipe splits a large result, and two small replies can arrive coalesced.
 *
 * Nothing tested that. Every other peer in the suite writes one whole line per
 * call, so the accumulate branch never ran with a partial message in it — the
 * lines are covered, the behaviour is not. That is the gap this closes, and it
 * is a property rather than an example because the interesting input is *any*
 * chunking, including the two that actually bite: a cut inside the JSON, and a
 * cut between the \r and the \n of a \r\n pair.
 */
const chunkPlan = fc.array(fc.integer({ min: 1, max: 47 }), {
  minLength: 1,
  maxLength: 6,
})

test(
  'a reply survives any chunking of the child’s stdout',
  { timeout: 120000 },
  async (t) => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(chunkPlan, { minLength: 1, maxLength: 4 }),
        async (plans) => {
          const port = await unusedPort()
          const gateway = launchGateway(
            t,
            [
              '--stdio',
              'node tests/helpers/chunking-mcp-peer.mjs',
              '--port',
              String(port),
            ],
            { CHUNK_PLAN: JSON.stringify(plans) },
          )
          try {
            await gateway.ready()

            const response = await fetch(`http://127.0.0.1:${port}/sse`, {
              headers: { accept: 'text/event-stream' },
            })
            const frames: string[] = []
            const reader = response.body!.getReader()
            const decoder = new TextDecoder()
            let buffer = ''
            void (async () => {
              for (;;) {
                const { value, done } = await reader.read()
                if (done) return
                buffer += decoder.decode(value, { stream: true })
                const lines = buffer.split('\n')
                buffer = lines.pop() ?? ''
                for (const line of lines)
                  if (line.startsWith('data:'))
                    frames.push(line.slice(5).trim())
              }
            })().catch(() => {})
            await gateway.waitFor(
              () => frames.some((frame) => frame.startsWith('/message')),
              'announce a message endpoint',
            )
            const endpoint = frames.find((f) => f.startsWith('/message'))!

            // One request per plan, so every generated chunking is exercised.
            const ids = plans.map((_, index) => 1000 + index)
            for (const id of ids) {
              await fetch(`http://127.0.0.1:${port}${endpoint}`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  jsonrpc: '2.0',
                  id,
                  method: 'tools/list',
                }),
              })
            }
            await gateway.waitFor(
              () =>
                ids.every((id) =>
                  frames.some((frame) => frame.includes(`"id":${id}`)),
                ),
              `deliver all ${ids.length} replies`,
            )

            const replies = frames
              .filter((frame) => !frame.startsWith('/message'))
              // A partial frame would throw here, which is the failure this is
              // looking for — the gateway forwarding half a message.
              .map((frame) => JSON.parse(frame))

            assert.deepEqual(
              replies.map((reply) => reply.id).sort((a, b) => a - b),
              ids,
              'every reply arrives exactly once, whatever the chunking',
            )
            for (const reply of replies) {
              assert.equal(
                reply.result.pad,
                'x'.repeat(120),
                'the payload is reassembled intact, not truncated at a chunk edge',
              )
            }
          } finally {
            // One gateway per generated case; do not leave a dozen running.
            await gateway.dispose()
          }
        },
      ),
      { numRuns: 12 },
    )
  },
)
