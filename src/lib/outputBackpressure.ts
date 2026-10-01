import type { Readable, Writable } from 'node:stream'

/**
 * Stop reading a child's stdout until its client has caught up, the way
 * `pipe()` does.
 *
 * Without this the gateway read everything a child wrote, however far behind
 * the client was, and queued it in the client's response. A client that
 * stopped reading made the gateway hold the child's whole output: a 128 MiB
 * burst to a paused SSE reader took the gateway to 327 MiB, and under CPU load
 * even a reader that kept draining could fall far enough behind for the
 * gateway to die of heap exhaustion, taking every other client with it
 * (GW-033). Each client has its own child, so holding that child's output
 * slows only the client that isn't reading. The child's own writes block on
 * the full pipe, and nothing it sends is dropped or reordered.
 *
 * Call it after passing a chunk of the child's output on, with what
 * `drained` or the WebSocket transport's `send` returned.
 */
export function holdOutput(
  stdout: Readable,
  drained: Promise<void> | undefined,
): void {
  if (!drained || stdout.isPaused()) return
  stdout.pause()
  void drained.then(() => stdout.resume())
}

/**
 * Settles when every response that is over its buffer limit has drained or
 * closed; undefined when none is over it.
 */
export function drained(
  responses: Iterable<Writable>,
): Promise<void> | undefined {
  // A destroyed response never reports needing to drain (Node checks that
  // itself), so a hold never waits for a `close` that has already happened.
  const full = [...responses].filter((res) => res.writableNeedDrain)
  if (full.length) return Promise.all(full.map(untilDrained)).then(() => {})
}

const untilDrained = (res: Writable) =>
  new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done)
      res.off('close', done)
      resolve()
    }
    res.on('drain', done)
    res.on('close', done)
  })

/**
 * The same hold for the bridges (--sse, --streamableHttp), whose output is
 * their own stdout: a response from the upstream server that is read only
 * while `output` keeps up.
 *
 * The bridges used to read everything upstream sent and queue it behind a
 * stdout nobody was reading: a 128 MiB burst to a stdio client that stopped
 * reading left a bridge at about 440 MiB, on Linux and macOS alike. Reading the
 * body only as stdout drains leaves the rest in the connection, so the
 * upstream server's own writes wait instead, as they do for any slow client.
 *
 * `url` and `redirected` are kept: the SSE client reads them to follow a
 * redirect on reconnect.
 */
export function readAsDrained(response: Response, output: Writable): Response {
  if (!response.body) return response
  const reader = response.body.getReader()
  const held = new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        await drained([output])
        const { done, value } = await reader.read()
        if (done) controller.close()
        else controller.enqueue(value)
      },
      cancel: (reason) => reader.cancel(reason),
    }),
    {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    },
  )
  Object.defineProperties(held, {
    url: { value: response.url },
    redirected: { value: response.redirected },
  })
  return held
}
