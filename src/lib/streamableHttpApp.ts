import type { CorsOptions } from 'cors'
import type { Express } from 'express'
import type { Logger } from '../types.js'
import { escapeSseJsonSeparators } from './escapeSseJsonSeparators.js'
import { setResponseHeaders } from './headers.js'
import { jsonBodyErrors } from './jsonBodyErrors.js'
import { requireApiKey } from './apiKey.js'
import { healthHandler, type ServerHealth } from './serverHealth.js'

/**
 * The Express app both Streamable HTTP gateways start from, with everything
 * that comes before their routes: SSE-safe JSON, --header on every response,
 * body parsing, CORS, the health endpoints and the API key check, in that
 * order.
 *
 * `express` and `cors` are the gateway's own, which tests replace per test.
 */
export function streamableHttpApp(
  express: typeof import('express'),
  cors: typeof import('cors'),
  {
    headers,
    corsOrigin,
    exposedHeaders,
    healthEndpoints,
    health,
    apiKeys,
    logger,
  }: {
    headers: Record<string, string>
    corsOrigin: CorsOptions['origin']
    /** Response headers a browser client may read, such as the session id. */
    exposedHeaders?: string[]
    healthEndpoints: string[]
    /** The server the health endpoints check, if not the gateway alone. */
    health?: ServerHealth
    apiKeys: string[]
    logger: Logger
  },
): Express {
  const app = express()
  app.use((_req, res, next) => {
    escapeSseJsonSeparators(res)
    // --header applies to every response, as it does in SSE mode. It used to
    // reach only the health endpoint.
    setResponseHeaders(res, headers)
    next()
  })
  // Same ceiling the SDK applies to SSE messages; express defaults to 100 kB.
  const parseJson = [express.json({ limit: '4mb' }), jsonBodyErrors]
  // Without keys, bodies are read here, as they always were. With keys, not
  // until the request has presented one: an unauthenticated caller must not
  // make the gateway read and parse up to 4 MB, and gets 401, not 400 or 413.
  if (apiKeys.length === 0) app.use(parseJson)

  if (corsOrigin)
    app.use(
      cors(
        exposedHeaders
          ? { origin: corsOrigin, exposedHeaders }
          : { origin: corsOrigin },
      ),
    )

  for (const ep of healthEndpoints) app.get(ep, healthHandler(health))

  // After CORS and the health endpoints, which stay open; before POST, GET
  // and DELETE on the path, modern 2026-07-28 requests included.
  app.use(requireApiKey(apiKeys, logger))
  if (apiKeys.length > 0) app.use(parseJson)
  return app
}
