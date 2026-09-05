import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import type { TestContext } from 'node:test'

export const errorDetails = {
  field: 'query',
  retryable: false,
  alternatives: ['a', 'b'],
}
export const shadowResult = {
  content: [{ type: 'text', text: 'extension data' }],
  hasOwnProperty: 'application-owned extension',
}

// Deliberately nonconforming frames require a wire peer rather than an SDK
// server that validates its own output. Gateway and client SDK are unchanged.
export async function wireUpstream(t: TestContext) {
  let events: ServerResponse | undefined
  const failures: unknown[] = []
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/sse') {
        events = res
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: endpoint\ndata: /messages\n\n')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      let body = ''
      for await (const chunk of req) body += chunk
      const message = JSON.parse(body)
      if (!('id' in message)) {
        res.writeHead(202).end()
        return
      }
      const envelope = (payload: object) => ({
        jsonrpc: '2.0',
        id: message.id,
        ...payload,
      })
      const name = message.params?.name
      if (name === 'malformed-json') {
        const invalid = [
          null,
          { code: 'invalid', message: 'wrong code' },
          { code: -32042 },
        ]
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            JSON.stringify(
              envelope({ error: invalid[message.params.arguments.variant] }),
            ),
          )
        return
      }
      const frames: unknown[] = []
      let payload: object
      if (message.method === 'initialize') {
        payload = {
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'wire-peer', version: '1.0.0' },
          },
        }
      } else if (name === 'failure' || name === 'error-data') {
        payload = {
          error: {
            code: -32042,
            message: 'Invalid query',
            ...(name === 'error-data' ? { data: errorDetails } : {}),
          },
        }
      } else if (name === 'shadow') {
        payload = { result: shadowResult }
      } else {
        if (name === 'malformed-events') {
          frames.push(null, envelope({ result: null }))
          for (const error of [
            null,
            false,
            'failure',
            { code: 'invalid', message: 'wrong code' },
            { code: -32042 },
            { code: -32042, message: 7 },
          ]) {
            frames.push(envelope({ error }))
          }
        }
        payload = {
          result:
            name === 'malformed-events'
              ? { content: [{ type: 'text', text: 'recovered' }] }
              : { tools: [] },
        }
      }
      frames.push(envelope(payload))
      const wire = frames
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join('')
      if (req.url === '/messages') {
        assert.ok(events, 'SSE endpoint must connect before posting')
        events.write(wire)
        res.writeHead(202).end()
      } else {
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(wire)
      }
    } catch (error) {
      failures.push(error)
      res.destroy()
    }
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    assert.deepEqual(failures, [], 'wire peer must not fail internally')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return { base: `http://127.0.0.1:${port}` }
}
