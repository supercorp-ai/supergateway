import { once } from 'node:events'
import type { TestContext } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { WebSocket } from 'ws'
import { initialize, launchGateway, unusedPort } from './gateway-process.js'

export type AuditMode = 'sse' | 'ws' | 'stateful' | 'stateless'
export async function auditClient(
  t: TestContext,
  mode: AuditMode,
  peer: string,
  env?: Record<string, string>,
) {
  const port = await unusedPort()
  const gateway = launchGateway(
    t,
    [
      '--stdio',
      peer,
      '--port',
      String(port),
      '--outputTransport',
      mode === 'stateful' || mode === 'stateless' ? 'streamableHttp' : mode,
      ...(mode === 'stateful' ? ['--stateful'] : []),
    ],
    env,
  )
  await gateway.ready()
  if (mode === 'ws') {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/message`)
    t.after(() => socket.terminate())
    await once(socket, 'open')
    let id = 0
    const request = async (body: object) => {
      const reply = once(socket, 'message')
      socket.send(JSON.stringify({ ...body, id: ++id }))
      return JSON.parse(String((await reply)[0])).result
    }
    const result = await request(initialize())
    return {
      gateway,
      pid: Number(result.serverInfo.version),
      call: (name: string) =>
        request({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name, arguments: {} },
        }),
    }
  }
  const client = new Client(
    { name: 'fault-audit', version: '1.0.0' },
    { capabilities: {} },
  )
  const url = new URL(
    `http://127.0.0.1:${port}/${mode === 'sse' ? 'sse' : 'mcp'}`,
  )
  const transport =
    mode === 'sse'
      ? new SSEClientTransport(url)
      : new StreamableHTTPClientTransport(url)
  t.after(() => client.close().catch(() => {}))
  t.after(() => transport.close().catch(() => {}))
  await client.connect(transport)
  return {
    gateway,
    pid: Number(client.getServerVersion()!.version),
    call: (name: string) => client.callTool({ name, arguments: {} }),
  }
}
