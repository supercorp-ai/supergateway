import type { Request, Response } from 'express'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'
import type { Logger } from '../types.js'
import type { Peer, StartPeer } from './childHandoff.js'
import { getVersion } from './getVersion.js'
import { DEFAULT_PROTOCOL_VERSION } from './childInitialization.js'

/** What a health endpoint reports: the gateway alone, or its MCP server. */
export type HealthCheck = 'gateway' | 'server'

export type Health = { ok: true } | { ok: false; reason: string }

// Long enough for a server that installs itself on first start (`npx -y`),
// short enough for a container health check's own timeout.
export const PROBE_TIMEOUT_MS = 10_000
// How long one answer stands for. A health endpoint polled every second
// still starts a server at most this often.
export const HEALTH_INTERVAL_MS = 10_000

/**
 * Starts an instance of the server, initializes it and pings it, then stops
 * it: healthy if it answered both within `timeoutMs`. A server that is up
 * but hung answers neither, which a check of the gateway alone cannot see
 * (#83).
 */
export function probeServer(
  start: StartPeer,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<Health> {
  return new Promise((resolve) => {
    const waiting = new Map<string, () => void>()
    let settled = false
    // Assigned before anything it says can arrive: a peer reports later.
    let peer!: Peer
    const settle = (health: Health) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void peer.stop()
      resolve(health)
    }
    const fail = (reason: string) => settle({ ok: false, reason })
    const timer = setTimeout(
      () => fail(`no answer within ${timeoutMs / 1000}s`),
      timeoutMs,
    )
    peer = start({
      message: (message) => {
        if ('method' in message || !('id' in message)) return
        const answered = waiting.get(String(message.id))
        if (!answered) return
        if ('error' in message)
          fail(`the server refused: ${message.error.message}`)
        else answered()
      },
      nonJson: () => {},
      stderr: () => {},
      failure: (_kind, err) => fail(`the server failed: ${describeError(err)}`),
      exit: (code, signal) =>
        fail(`the server exited (code=${code}, signal=${signal})`),
      output: () => undefined,
    })
    const ask = (
      message: JSONRPCMessage & { id: string },
      then: () => void,
    ) => {
      waiting.set(message.id, then)
      peer.write(message)
    }
    ask(
      {
        jsonrpc: '2.0',
        id: 'supergateway-health-initialize',
        method: 'initialize',
        params: {
          protocolVersion: DEFAULT_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'supergateway-health', version: getVersion() },
        },
      },
      () => {
        peer.write({ jsonrpc: '2.0', method: 'notifications/initialized' })
        ask(
          { jsonrpc: '2.0', id: 'supergateway-health-ping', method: 'ping' },
          () => settle({ ok: true }),
        )
      },
    )
  })
}

// fetch's own message is only "fetch failed"; why is in its cause.
const describeError = (err: Error) =>
  err.cause instanceof Error
    ? `${err.message} (${err.cause.message})`
    : err.message

/**
 * A server's health, probed at most once per interval however often it is
 * asked, and once at a time.
 */
export class ServerHealth {
  private last: { at: number; health: Health } | undefined
  private probing: Promise<Health> | undefined

  constructor(
    private readonly probe: () => Promise<Health>,
    private readonly logger: Logger,
    private readonly intervalMs = HEALTH_INTERVAL_MS,
    private readonly now = Date.now,
  ) {}

  check(): Promise<Health> {
    const { last } = this
    if (last && this.now() - last.at < this.intervalMs)
      return Promise.resolve(last.health)
    this.probing ??= this.probe().then((health) => {
      this.probing = undefined
      // Said when it changes, not on every poll.
      if (!health.ok && last?.health.ok !== false)
        this.logger.error(
          `Health check: the server is unhealthy: ${health.reason}`,
        )
      if (health.ok && last?.health.ok === false)
        this.logger.info('Health check: the server is healthy again')
      this.last = { at: this.now(), health }
      return health
    })
    return this.probing
  }
}

/**
 * A health endpoint's handler: `ok` for the gateway alone, or, with a
 * server to check, `ok` while it answers and 503 with the reason when not.
 * `before` runs first on every request (SSE puts --header on it).
 */
export const healthHandler =
  (
    health: ServerHealth | undefined,
    before: (res: Response) => void = () => {},
  ) =>
  async (_req: Request, res: Response) => {
    before(res)
    if (!health) {
      res.send('ok')
      return
    }
    const result = await health.check()
    if (result.ok) res.send('ok')
    else res.status(503).send(`unhealthy: ${result.reason}`)
  }

/**
 * What a gateway's health endpoints report, as --healthCheck chose: with
 * "server", a server started by `start` for each probe, unless the gateway
 * is shutting down and starts no more.
 *
 * `start` gets a logger without errors: why a probe failed is its reason,
 * logged once when health changes, not a trace on every probe.
 */
export const serverHealthOf = (
  healthCheck: HealthCheck | undefined,
  children: { readonly closing: boolean },
  start: (logger: Logger) => StartPeer,
  logger: Logger,
) =>
  healthCheck === 'server'
    ? new ServerHealth(
        () =>
          children.closing
            ? Promise.resolve({
                ok: false as const,
                reason: 'the gateway is shutting down',
              })
            : probeServer(start({ ...logger, error: () => {} })),
        logger,
      )
    : undefined
