import { createServer, type ServerResponse } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import type { TestContext } from 'node:test'

export async function faultControl(t: TestContext) {
  const events: {
    kind: string
    pid: number
    query: URLSearchParams
    response: ServerResponse
  }[] = []
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost')
    events.push({
      kind: url.pathname.slice(1),
      pid: Number(url.searchParams.get('pid')),
      query: url.searchParams,
      response,
    })
    if (url.pathname !== '/hold') response.end('release')
  })
  t.after(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`
  const wait = async (kind: string, pid?: number, ms = 5000) => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      const event = events.find(
        (event) =>
          event.kind === kind && (pid === undefined || event.pid === pid),
      )
      if (event) return event
      await delay(10)
    }
    throw Error(
      `Peer never reported ${kind} for pid ${pid ?? 'any'} within ${ms}ms`,
    )
  }
  return { url, events, wait }
}
