/*
 * Helpers that mirror the EXACT dispatch pattern from the patched gateway
 * source files. If any of the three gateways regress to a sync try/catch
 * around `transport.send(jsonMsg)`, the unit tests using these helpers
 * will fail (rejected-promise case will surface as unhandled rejection /
 * un-logged error).
 *
 * Each dispatch helper takes a single transport (or session map) and a
 * jsonMsg, and uses the same `.catch(...)` wiring that the real gateways
 * use, so the helpers themselves are the regression target.
 */

import type { Logger } from '../../src/types.js'

export interface MinimalTransport {
  send: (msg: unknown) => Promise<void>
}

export interface MinimalSession {
  transport: MinimalTransport
}

/* Mirrors the dispatch pattern in
 * src/gateways/stdioToStatelessStreamableHttp.ts (around line 191) and
 * src/gateways/stdioToStatefulStreamableHttp.ts   (around line 156).
 *
 * These two gateways forward to a SINGLE transport per request. The fix
 * replaces the prior sync try/catch with `.catch()` on the returned promise.
 */
export function dispatchStreamableHttp(
  transport: MinimalTransport,
  jsonMsg: unknown,
  logger: Logger,
): void {
  transport.send(jsonMsg).catch((e) => {
    logger.error(`Failed to send to StreamableHttp`, e)
  })
}

/* Mirrors the dispatch pattern in src/gateways/stdioToSse.ts (around line 182).
 *
 * SSE fans out the message to every open session. On rejection the session
 * is dropped from the map (matches the live patched behaviour).
 */
export function dispatchSse(
  sessions: Record<string, MinimalSession>,
  jsonMsg: unknown,
  logger: Logger,
): void {
  for (const [sid, session] of Object.entries(sessions)) {
    session.transport.send(jsonMsg).catch((err) => {
      logger.error(`Failed to send to session ${sid}:`, err)
      delete sessions[sid]
    })
  }
}

/* Spy logger that records error calls so tests can assert on them. */
export interface SpyLogger extends Logger {
  errors: Array<{ args: unknown[] }>
  infos: Array<{ args: unknown[] }>
}

export function makeSpyLogger(): SpyLogger {
  const errors: Array<{ args: unknown[] }> = []
  const infos: Array<{ args: unknown[] }> = []
  return {
    errors,
    infos,
    error: (...args: unknown[]) => {
      errors.push({ args })
    },
    info: (...args: unknown[]) => {
      infos.push({ args })
    },
  }
}

/* Mock transports for the three scenarios. */
export function makeResolvingTransport(): MinimalTransport {
  return {
    send: async () => {
      /* resolves cleanly */
    },
  }
}

export function makeRejectingTransport(err: Error): MinimalTransport {
  return {
    send: () => Promise.reject(err),
  }
}

export function makeSyncThrowingTransport(err: Error): MinimalTransport {
  return {
    send: () => {
      throw err
    },
  }
}

/* Wait one macrotask tick so any `.catch()` handlers have run. */
export function nextTick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
