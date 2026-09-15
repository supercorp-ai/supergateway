// The server half of the cross-client conformance battery.
//
// Every client driver runs the same scenarios against this peer, so the results
// form a matrix rather than a pile of per-client smoke tests. Each tool is here
// because it exercises something a relay can plausibly get wrong, not because it
// rounds out a list.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer({ name: 'battery-peer', version: '1.0.0' })

// Legal in JSON, treated as line terminators by some consumers.
export const SEPARATORS = 'before' + '\u2028' + 'middle' + '\u2029' + 'after'
// Emoji with a ZWJ sequence, a right-to-left run, combining marks, CJK, and a
// character outside the BMP — everything that makes a naive length or slice go
// wrong somewhere in the chain.
export const UNICODE = 'a👩‍👩‍👧‍👦b عربى c éèê d 漢字 e 𝔘𝔫𝔦 f'
export const PLAIN = 'plain-result'
export const BIG_LENGTH = Number(process.env.BIG_LENGTH ?? 1024 * 1024)

server.tool('plain', {}, async () => ({
  content: [{ type: 'text', text: PLAIN }],
}))

server.tool('separators', {}, async () => ({
  content: [{ type: 'text', text: SEPARATORS }],
}))

server.tool('unicode', {}, async () => ({
  content: [{ type: 'text', text: UNICODE }],
}))

// A megabyte in one frame, which is where chunked stdout and body limits bite.
server.tool('large', {}, async () => ({
  content: [{ type: 'text', text: 'x'.repeat(BIG_LENGTH) }],
}))

// A tool that reports failure the MCP way — a result with isError, not a
// protocol error. A relay that promotes this to a JSON-RPC error changes its
// meaning.
server.tool('toolError', {}, async () => ({
  isError: true,
  content: [{ type: 'text', text: 'the tool failed on purpose' }],
}))

// A tool that throws, which the SDK turns into a protocol error.
server.tool('throws', {}, async () => {
  throw new Error('deliberate throw')
})

// Echoes its arguments back as JSON text, so the client can check that what it
// sent survived the trip in both directions.
server.tool(
  'echo',
  {
    text: z.string().optional(),
    number: z.number().optional(),
    flag: z.boolean().optional(),
    nested: z.any().optional(),
  },
  async (args) => ({
    content: [{ type: 'text', text: JSON.stringify(args) }],
  }),
)

// Slower than a trivial call, to catch a client or relay that gives up early.
server.tool('slow', {}, async () => {
  await new Promise((r) => setTimeout(r, 1500))
  return { content: [{ type: 'text', text: 'slow-done' }] }
})

// A result carrying a field named `error`, which is application data rather
// than a protocol error — cluster E's shape.
server.tool('shadowedError', {}, async () => ({
  content: [{ type: 'text', text: 'ok' }],
  error: { code: -1, message: 'application data, not a protocol error' },
}))

await server.connect(new StdioServerTransport())
