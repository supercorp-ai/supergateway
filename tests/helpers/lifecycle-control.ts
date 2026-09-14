import { createServer, type ServerResponse } from 'node:http'
import type { TestContext } from 'node:test'

export async function lifecycleControl(t: TestContext) {
  let arrive!: (response: ServerResponse) => void
  const started = new Promise<ServerResponse>((resolve) => {
    arrive = resolve
  })
  const server = createServer((_req, res) => arrive(res))
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    peerCommand: `node tests/helpers/lifecycle-mcp-peer.mjs http://127.0.0.1:${port}/control`,
    started,
  }
}

export function pendingRpc(
  t: TestContext,
  url: string,
  message: object,
  session?: string,
) {
  const abort = new AbortController()
  t.after(() => abort.abort())
  // Attach rejection handling immediately, including while awaiting tool start.
  const settled = fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(session ? { 'mcp-session-id': session } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
  })
    .then(async (response) => ({
      kind: 'response' as const,
      status: response.status,
      text: await response.text(),
    }))
    .catch((error: Error) => ({ kind: 'error' as const, error }))
  return { abort: () => abort.abort(), settled }
}
