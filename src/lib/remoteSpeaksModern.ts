import type { RemoteServer } from './upstreamPeer.js'
import type { Logger } from '../types.js'
import { MODERN_VERSION } from './modernVersion.js'
import { getVersion } from './getVersion.js'

/** How long an answer about what a remote server speaks stands. */
export const SPEAKS_FOR_MS = 60_000
const DISCOVER_TIMEOUT_MS = 10_000

/**
 * Whether a remote server speaks 2026-07-28, asked with `server/discover`
 * and remembered for a minute.
 *
 * A remote server that does not must be served exactly as before there was a
 * relay for it: its clients are told the version is not supported, and fall
 * back to the one it speaks. Sending it their 2026-07-28 requests instead
 * would answer them with whatever it makes of those.
 */
export function remoteSpeaksModern(
  remote: RemoteServer,
  logger: Logger,
  now: () => number = Date.now,
) {
  let last: { at: number; speaks: Promise<boolean> } | undefined
  return (): Promise<boolean> => {
    if (last && now() - last.at < SPEAKS_FOR_MS) return last.speaks
    const speaks = discovers(remote).then((speaks) => {
      logger.info(
        `The remote server ${speaks ? 'speaks' : 'does not speak'} ${MODERN_VERSION}`,
      )
      return speaks
    })
    last = { at: now(), speaks }
    return speaks
  }
}

// Whether `server/discover` is answered with the version among those the
// server supports. Anything else, an error or silence included, is a no.
async function discovers(remote: RemoteServer): Promise<boolean> {
  try {
    const response = await fetch(remote.url, {
      method: 'POST',
      signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      headers: {
        ...remote.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': MODERN_VERSION,
        'mcp-method': 'server/discover',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'supergateway-discover',
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': MODERN_VERSION,
            'io.modelcontextprotocol/clientInfo': {
              name: 'supergateway',
              version: getVersion(),
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    })
    const text = await response.text()
    // An event stream's first message, or the JSON body.
    const body = (response.headers.get('content-type') ?? '').includes(
      'text/event-stream',
    )
      ? text
          .split(/\r?\n/)
          .find((line) => line.startsWith('data:'))!
          .slice(5)
      : text
    const versions = JSON.parse(body).result.supportedVersions
    return response.ok && versions.includes(MODERN_VERSION)
  } catch {
    return false
  }
}
