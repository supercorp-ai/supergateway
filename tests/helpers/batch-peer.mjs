// A server that takes JSON-RPC batches (2025-03-26), as some servers still do,
// and answers each in a batch. Its tools are "open" and "secret"; a call says
// which tool it reached.
import { createInterface } from 'node:readline'

const answer = ({ id, method, params }) => {
  if (id === undefined) return undefined
  if (method === 'initialize')
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'batch-peer', version: '1' },
      },
    }
  if (method === 'tools/list')
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: ['open', 'secret'].map((name) => ({
          name,
          inputSchema: { type: 'object' },
        })),
      },
    }
  if (method === 'tools/call')
    return {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: `reached ${params.name}` }] },
    }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: method } }
}

for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  const reply = Array.isArray(message)
    ? message.map(answer).filter(Boolean)
    : answer(message)
  if (reply && (!Array.isArray(reply) || reply.length))
    process.stdout.write(JSON.stringify(reply) + '\n')
}
