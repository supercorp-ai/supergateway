import type { IncomingMessage, Server } from 'http'
import type { Duplex } from 'node:stream'
import { createServer } from 'http'
import express from 'express'
import type { Logger } from '../types.js'
import { onSignals } from './onSignals.js'
import { keepConnectionsAlive } from './keepConnectionsAlive.js'
import { listenOn } from './listenHost.js'

/**
 * One server's part of a listening gateway: its routes, ready to be served on
 * a port it shares with others, or has to itself.
 */
export interface Mount {
  /**
   * The server's routes, at their full paths. An Express app, so it can be
   * listened on directly when it is the only one.
   */
  app: express.Express
  /** The URL path its requests start with; `/` takes every request. */
  path: string
  /** For a WebSocket server: the path it upgrades, and how. */
  upgrade?: {
    path: string
    handle: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  }
  /** Logs the server's URLs, once the port is open. */
  listening: (host: string | undefined, port: number) => void
  /** Stops its sessions and children, for the gateway's shutdown. */
  close: () => Promise<void>
}

/**
 * The mount a request belongs to: the one with the longest path the request's
 * path starts with, segment by segment, so `/git` takes `/git/sse` but not
 * `/github/sse`.
 */
export function mountFor<M extends Pick<Mount, 'path'>>(
  mounts: M[],
  path: string,
): M | undefined {
  let found: M | undefined
  for (const mount of mounts) {
    const inside =
      mount.path === '/' ||
      path === mount.path ||
      path.startsWith(`${mount.path}/`)
    if (
      inside &&
      (found === undefined || mount.path.length > found.path.length)
    )
      found = mount
  }
  return found
}

/**
 * Listens on `port` for several servers, and owns what is the gateway's
 * rather than one server's: the shutdown, keep-alive and the gateway's own
 * health endpoints. One Express app answers those and sends every other
 * request to its mount; a request no mount takes gets Express's 404.
 *
 * A server alone on the port doesn't come here: each gateway's own function
 * listens for it, exactly as before there could be more than one.
 */
export function serve({
  port,
  host,
  logger,
  mounts,
  healthEndpoints,
}: {
  port: number
  host: string | undefined
  logger: Logger
  mounts: Mount[]
  /** The gateway's own health endpoints. */
  healthEndpoints: string[]
}): Server {
  onSignals({
    logger,
    cleanup: async () => {
      await Promise.all(mounts.map((mount) => mount.close()))
    },
    drainStdin: true,
  })

  const handler = shared(mounts, healthEndpoints)

  const onListening = () => {
    logger.info(`Listening on port ${port}`)
    // Never empty: `serve` is for several servers.
    mounts.forEach((mount) => mount.listening(host, port))
  }

  const sockets = mounts.filter((mount) => mount.upgrade !== undefined)
  if (sockets.length === 0)
    return keepConnectionsAlive(listenOn(handler, port, host, onListening))
  // @types/express declares RequestHandler as returning `void | Promise<void>`,
  // and Application extends it, so the rule sees a possibly-async handler.
  // Express 4's app is not one: it is `function (req, res, next) {
  // app.handle(req, res, next) }` — arity 3, returns undefined. Passing it to
  // http.createServer is the documented pattern, so this is a declaration
  // artifact rather than a floating promise.
  // eslint-disable-next-line @typescript-eslint/no-misused-promises
  const httpServer: Server = keepConnectionsAlive(createServer(handler))
  // An upgrade for no WebSocket path still goes to one, which refuses it the
  // way a WebSocket server alone on the port always has.
  httpServer.on('upgrade', (req, socket, head) => {
    // Always set on a request a server received; only a client's own
    // IncomingMessage lacks it.
    const path = req.url!.split('?')[0]
    const target =
      sockets.find((mount) => mount.upgrade!.path === path) ?? sockets[0]
    target.upgrade!.handle(req, socket, head)
  })
  return listenOn(httpServer, port, host, onListening)
}

function shared(mounts: Mount[], healthEndpoints: string[]) {
  const app = express()
  for (const ep of healthEndpoints)
    app.get(ep, (_req, res) => {
      res.send('ok')
    })
  app.use((req, res, next) => {
    const mount = mountFor(mounts, req.path)
    if (!mount) return next()
    // An Express 4 app returns nothing; @types/express says it may return a
    // promise (see the createServer note above).
    void mount.app(req, res, next)
  })
  return app
}

/**
 * Why several servers can't share the port as configured, if they can't: a
 * URL one of them serves that its requests would never reach, because the
 * gateway's health endpoint answers it, or another server's path holds it.
 */
export function routeConflict(
  servers: { name: string; path: string; routes: string[] }[],
  healthEndpoints: string[],
): string | undefined {
  for (const server of servers)
    for (const route of server.routes) {
      if (healthEndpoints.includes(route))
        return `"${server.name}" serves ${route}, which is also the gateway's health endpoint`
      // Every route is under its server's own path, so some server holds it.
      const owner = mountFor(servers, route)!
      if (owner !== server)
        return `"${server.name}" serves ${route}, but "${owner.name}" at ${owner.path} would receive it. Give one of them a different "path"`
    }
  return undefined
}
