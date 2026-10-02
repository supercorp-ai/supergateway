import type { CorsOptions } from 'cors'
import type { Logger } from '../types.js'
import { describeHeaders } from './headers.js'
import { announceHost } from './listenHost.js'
import { announceServer, type ServerSource } from './serverSource.js'
import { serializeCorsOrigin } from './serializeCorsOrigin.js'
import { logApiKeys } from './apiKey.js'

/**
 * A listening gateway's startup listing, in the order every gateway prints
 * it: response headers, port and host, the server, the transport's own
 * settings, then CORS, health endpoints and API keys.
 *
 * The port is listed only for a server that has it to itself; beside others,
 * the gateway lists it once for all of them.
 */
export function announceGateway(
  logger: Logger,
  {
    headers,
    port,
    host,
    source,
    settings,
    corsOrigin,
    healthEndpoints,
    apiKeys,
  }: {
    /** Left out by WebSocket, which sets no response headers. */
    headers?: Record<string, string>
    port?: number
    host?: string
    source: ServerSource
    /** The transport's own lines, such as `ssePath: /sse`. */
    settings: string[]
    corsOrigin: CorsOptions['origin']
    healthEndpoints: string[]
    apiKeys: string[]
  },
) {
  if (headers) logger.info(`  - Headers: ${describeHeaders(headers)}`)
  if (port !== undefined) {
    logger.info(`  - port: ${port}`)
    announceHost(logger, host)
  }
  announceServer(logger, source)
  // Every transport has at least its path.
  settings.forEach((setting) => logger.info(`  - ${setting}`))
  logger.info(
    `  - CORS: ${corsOrigin ? `enabled (${serializeCorsOrigin({ corsOrigin })})` : 'disabled'}`,
  )
  logger.info(
    `  - Health endpoints: ${healthEndpoints.length ? healthEndpoints.join(', ') : '(none)'}`,
  )
  logApiKeys(logger, apiKeys)
}
