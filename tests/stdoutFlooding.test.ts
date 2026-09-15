import assert from 'node:assert/strict'
import { knownBugTest } from './helpers/known-bug.js'
import { launchGateway, unusedPort } from './helpers/gateway-process.js'

/**
 * GW-028: a child that writes a long newline-free run to stdout kills the
 * gateway.
 *
 * All four gateways read the child the same way:
 *
 *     buffer += chunk.toString('utf8')
 *     const lines = buffer.split(/\r?\n/)
 *     buffer = lines.pop()!
 *
 * There is no cap on `buffer`. Until a newline arrives nothing is consumed, and
 * every chunk reallocates the whole accumulated string, so peak memory runs
 * several times the bytes received. Measured on the real CLI with a peer
 * emitting 512 MB with no newline in it: resident memory sawtoothed up to about
 * 2 GB, and with the heap capped at 192 MB every gateway died the same way —
 *
 *     sse        SIGABRT  FATAL ERROR: Reached heap limit ... heap out of memory
 *     ws         SIGABRT  same
 *     stateful   SIGABRT  same (once a request has made it spawn a child)
 *     stateless  SIGABRT  same
 *
 * No malice is needed. Anything the server prints to stdout that is not
 * newline-terminated MCP traffic accumulates: a large stack trace, a base64
 * blob, a progress indicator written with carriage returns. The gateway has no
 * way back — it is an abort, not an error it can report.
 *
 * What the fix looks like: cap the buffer, and when a single line exceeds the
 * cap, log it and discard rather than keep growing. A line that large cannot be
 * a JSON-RPC message the client could have used anyway.
 *
 * The heap is capped here so the failure takes seconds rather than minutes and
 * cannot exhaust the machine running the suite.
 */
const CASES = [
  { label: 'sse', args: ['--outputTransport', 'sse'], poke: false },
  { label: 'ws', args: ['--outputTransport', 'ws'], poke: false },
  {
    label: 'stateful HTTP',
    args: ['--outputTransport', 'streamableHttp', '--stateful'],
    poke: true,
  },
  {
    label: 'stateless HTTP',
    args: ['--outputTransport', 'streamableHttp'],
    poke: true,
  },
] as const

for (const mode of CASES) {
  knownBugTest(
    'GW-028',
    `${mode.label}: survives a child that floods stdout without a newline`,
    { timeout: 180000 },
    async (t) => {
      const port = await unusedPort()
      const gateway = launchGateway(
        t,
        [
          '--stdio',
          'node tests/helpers/flooding-peer.mjs',
          '--port',
          String(port),
          ...mode.args,
          '--logLevel',
          'none',
        ],
        { NODE_OPTIONS: '--max-old-space-size=192', FLOOD_MB: '512' },
      )
      await gateway.ready()

      // The HTTP gateways spawn the child per request, so without one there is
      // nothing to flood and the test would pass for the wrong reason.
      if (mode.poke) {
        await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              clientInfo: { name: 'flood', version: '1.0.0' },
            },
          }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => {})
      }

      const died = await Promise.race([
        gateway.exited,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 90000)),
      ])
      assert.equal(
        died,
        null,
        `the gateway died reading its child: ${JSON.stringify(died)}\n` +
          gateway.errors().slice(-400),
      )
    },
  )
}
