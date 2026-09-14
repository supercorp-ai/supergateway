import { createServer, type ServerResponse } from 'node:http'
import type { TestContext } from 'node:test'

/**
 * Wait for `promise`, but fail with a named step instead of stalling until the
 * runner's own timeout, which reports only that the test as a whole hung.
 */
export function within<T>(promise: Promise<T>, step: string, ms = 10000) {
  const raced = Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(Error(`Timed out after ${ms}ms waiting to ${step}.`)),
        ms,
      ).unref(),
    ),
  ])
  raced.catch(() => {})
  return raced
}

export async function lifecycleControl(t: TestContext) {
  let arrive!: (response: ServerResponse) => void
  const arrived = new Promise<ServerResponse>((resolve) => {
    arrive = resolve
  })
  // Waiting on this without a deadline turns every way the peer can fail to
  // report - an idle session expiring before the call lands, a child killed
  // first - into an opaque "test timed out" with nothing to read. Name the
  // likely cause instead, while leaving the test its own budget to report in.
  const started = Promise.race([
    arrived,
    new Promise<never>((_, reject) =>
      setTimeout(
        () =>
          reject(
            Error(
              'The lifecycle peer never reported starting within 10s. Its session may have expired, or its child exited, before the request reached it.',
            ),
          ),
        10000,
      ).unref(),
    ),
  ])
  // A test that never awaits it must not raise an unhandled rejection.
  started.catch(() => {})
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
