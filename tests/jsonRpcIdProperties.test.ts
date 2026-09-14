import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * A gateway must hand back the id the client sent, unchanged and of the same
 * type. JSON-RPC 2.0 allows a string or a number, and a client matches replies
 * to requests on exactly this value — an id that comes back altered is a reply
 * the client can never claim, so the call hangs rather than fails.
 *
 * Written as a property because the bug in this area is a *type* bug, not a
 * value bug: GW-018 is `parseInt` applied to an id that was a string, and no
 * example test using a numeric id can see it. The generator is the point. The
 * WebSocket gateway fails this property today (see wsClientIdentity.test.ts);
 * SSE passes it, and this pins that, because the GW-017 fix is expected to
 * introduce per-client routing here and routing by id is the tempting way.
 */
const jsonRpcId = fc.oneof(
  fc.integer(),
  fc.string({ maxLength: 24 }),
  // The shapes that break naive id handling: a colon (used as a separator by
  // the WebSocket transport), digits-as-a-string (survives a careless
  // parseInt with its type silently changed), zero (falsy), and empty.
  fc.constantFrom('a:b', '42', '0', '', '-1', 'urn:uuid:1234', 0, -1),
)

test(
  'the SSE gateway returns the request id unchanged, whatever its type',
  { timeout: 120000 },
  async (t) => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(jsonRpcId, { minLength: 1, maxLength: 6 }),
        async (ids) => {
          const port = await unusedPort()
          const gateway = launchGateway(t, [
            '--stdio',
            'node tests/helpers/chunking-mcp-peer.mjs',
            '--port',
            String(port),
          ])
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

            const replies = () =>
              frames
                .filter((frame) => !frame.startsWith('/message'))
                .map((frame) => JSON.parse(frame))
            await gateway.waitFor(
              () => replies().length >= ids.length,
              `deliver ${ids.length} replies`,
            )

            const returned = replies().map((reply) => reply.id)
            // Deep equality, not ==: the failure this is looking for is a
            // string id coming back as a number, or as null.
            assert.deepEqual(
              [...returned].sort(),
              [...ids].sort(),
              'every id comes back exactly as it was sent, same type included',
            )
          } finally {
            await gateway.dispose()
          }
        },
      ),
      { numRuns: 10 },
    )
  },
)
