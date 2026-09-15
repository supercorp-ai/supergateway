// An MCP server whose tool results carry characters that are legal in JSON but
// treated as line terminators by some consumers.
//
// Built on the SDK rather than hand-rolled so protocol framing is not a
// variable: the only thing separating these two tools is what is inside the
// text. That is issue #91's shape — a fetched document containing U+2028.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'

const server = new McpServer({ name: 'separator-peer', version: '1.0.0' })

// U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, written as escapes so
// this file stays readable in editors that render them as line breaks.
export const SEPARATOR_TEXT =
  'before' + '\u2028' + 'middle' + '\u2029' + 'after'
export const PLAIN_TEXT = 'before-middle-after'

server.tool('separators', {}, async () => ({
  content: [{ type: 'text', text: SEPARATOR_TEXT }],
}))

server.tool('plain', {}, async () => ({
  content: [{ type: 'text', text: PLAIN_TEXT }],
}))

// A successful result that happens to carry a field named `error`. That is
// application data, not a JSON-RPC error, and reading it as one is cluster E's
// defect (GW-002). Without a payload like this an identity check cannot tell
// the two spellings apart.
server.tool('shadowed-error', {}, async () => ({
  content: [{ type: 'text', text: 'ok' }],
  error: { code: -1, message: 'application data, not a protocol error' },
}))

await server.connect(new StdioServerTransport())
