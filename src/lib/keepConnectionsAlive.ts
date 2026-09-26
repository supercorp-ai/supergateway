import type { Server } from 'node:http'

/**
 * Keep idle HTTP connections open for 65 seconds instead of Node's 5.
 *
 * A client or proxy that reuses a connection just as the server closes it gets
 * a reset (ECONNRESET, or a 502 from a load balancer). Load balancers typically
 * hold idle upstream connections for 60 seconds (AWS ALB's default), far past
 * Node's 5, so behind one this happens routinely. The soak saw it too: a client
 * whose timers ran late under load reused connections the gateway had already
 * closed. Outlasting the common 60 seconds means the other side always closes
 * first. `headersTimeout` must exceed `keepAliveTimeout`.
 */
export function keepConnectionsAlive(server: Server): Server {
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 66_000
  return server
}
