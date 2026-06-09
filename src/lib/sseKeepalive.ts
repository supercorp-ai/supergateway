import type express from 'express'
import type { Logger } from '../types.js'

const DEFAULT_INTERVAL_MS = 25_000

export interface SseKeepaliveArgs {
  res: express.Response
  logger: Logger
  intervalMs?: number
}

/**
 * Defeat the Claude Code HTTP MCP 60s first-byte fetch abort by emitting an
 * SSE comment line every ~25s while the response is open. Comment lines
 * (`: ...\n\n`) are valid in `text/event-stream` per W3C SSE spec and are
 * silently discarded by every conforming SSE parser — including the one in
 * @modelcontextprotocol/sdk's StreamableHTTPServerTransport, which reads
 * via fetch + ReadableStream and resets its own abort timer on every byte.
 *
 * Only engages once the response has flipped to `text/event-stream`; for
 * one-shot JSON replies the helper is a no-op so we don't corrupt the body.
 *
 * Stops on `finish` or `close`.
 *
 * Why this exists: anthropics/claude-code hardcodes a 60s
 * AbortSignal.timeout(60000) on the fetch underlying HTTP/streamable-HTTP
 * MCP tool calls. Per-server `timeout` and `MCP_TOOL_TIMEOUT` are
 * protocol-level and ignored by the transport. The only fix is server-side
 * keepalive — see issue #36221.
 */
export const applySseKeepalive = ({
  res,
  logger,
  intervalMs = DEFAULT_INTERVAL_MS,
}: SseKeepaliveArgs): void => {
  let timer: NodeJS.Timeout | null = null
  let stopped = false

  const stop = (reason: string) => {
    if (stopped) return
    stopped = true
    if (timer) {
      clearInterval(timer)
      timer = null
    }
    logger.info(`SSE keepalive stopped (${reason})`)
  }

  const start = () => {
    if (timer || stopped) return
    const ct = String(res.getHeader('content-type') || '')
    if (!ct.toLowerCase().includes('text/event-stream')) return
    logger.info(`SSE keepalive engaged (interval=${intervalMs}ms)`)
    timer = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        stop('writable ended/destroyed')
        return
      }
      try {
        res.write(': keepalive\n\n')
      } catch (e) {
        stop(`write threw: ${(e as Error).message}`)
      }
    }, intervalMs)
    // Don't keep the event loop alive just for keepalives.
    timer.unref?.()
  }

  // Headers may flush on the first transport.send(); engage right after.
  // setHeader/writeHead happens synchronously inside handleRequest before
  // the first body write, so a single immediate poll plus a short retry
  // covers the race without spinning.
  const tryStart = () => start()
  tryStart()
  const probe = setTimeout(tryStart, 100)
  probe.unref?.()

  res.on('finish', () => stop('finish'))
  res.on('close', () => stop('close'))
}
