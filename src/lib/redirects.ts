import type { Logger } from '../types.js'
import type { RemoteServer } from './upstreamPeer.js'

/**
 * `fetch` for a remote server, following its redirects without handing its
 * configured headers to anyone else.
 *
 * `fetch` drops only `Authorization` when a redirect leaves the origin, and
 * the SDK's transports now refuse every such redirect, http to https
 * included, which would end a bridge that has always worked through one. So
 * every redirect is still followed, as before, and where it goes decides
 * which headers are sent along:
 *
 * - the same origin, or the same host moving from http to https on the
 *   default ports, gets the configured headers, as it always has;
 * - any other origin gets the request without them, and without
 *   `Authorization` and `Cookie`, logged once for each origin.
 *
 * Once dropped they stay dropped, however the redirects go on, as `fetch`
 * drops `Authorization`. The rest is `fetch`'s own redirect handling: 303,
 * and 301 or 302 after a POST, become a GET without a body; at most 20.
 */
export const redirectSafeFetch = (
  configured: Record<string, string>,
  logger: Logger,
  // Every caller uses the global `fetch`; tests give their own.
  send: typeof fetch = (...args) => fetch(...args),
) => {
  const warned = new Set<string>()
  const private_ = [...Object.keys(configured), 'authorization', 'cookie']
  return async (input: string | URL, init: RequestInit = {}) => {
    let url = new URL(input)
    let method = (init.method ?? 'GET').toUpperCase()
    let body = init.body
    const headers = new Headers(init.headers)
    for (let followed = 0; ; followed++) {
      const response = await send(url, {
        ...init,
        method,
        body,
        headers,
        redirect: 'manual',
      })
      const location = response.headers.get('location')
      if (!REDIRECTS.has(response.status) || location === null)
        return followed === 0 ? response : redirected(response, url)
      await response.body?.cancel()
      if (followed === MAX_REDIRECTS)
        throw new TypeError(`Too many redirects from ${input}`)
      const next = new URL(location, url)
      if (!keepsHeaders(url, next) && private_.some((n) => headers.has(n))) {
        // Never empty: Authorization and Cookie are always on it.
        private_.forEach((name) => headers.delete(name))
        if (!warned.has(next.origin)) {
          warned.add(next.origin)
          logger.error(
            `${url.origin} redirected to ${next.origin}: following it without the configured headers`,
          )
        }
      }
      if (
        response.status === 303
          ? method !== 'GET' && method !== 'HEAD'
          : response.status !== 307 &&
            response.status !== 308 &&
            method === 'POST'
      ) {
        method = 'GET'
        body = undefined
        for (const name of BODY_HEADERS) headers.delete(name)
      }
      url = next
    }
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])
// Fetch's own limit.
const MAX_REDIRECTS = 20
// The headers fetch drops with a body it no longer sends.
const BODY_HEADERS = [
  'content-encoding',
  'content-language',
  'content-location',
  'content-type',
]

/** Whether a redirect from `from` to `to` may carry the configured headers. */
export const keepsHeaders = (from: URL, to: URL) =>
  from.origin === to.origin ||
  (from.protocol === 'http:' &&
    to.protocol === 'https:' &&
    from.hostname === to.hostname &&
    from.port === '' &&
    to.port === '')

// The SSE client reads `url` and `redirected` to reconnect where a redirect
// led, as it did when `fetch` followed it.
const redirected = (response: Response, url: URL) =>
  Object.defineProperties(response, {
    url: { value: url.href },
    redirected: { value: true },
  })

const byRemote = new WeakMap<
  RemoteServer,
  ReturnType<typeof redirectSafeFetch>
>()

/**
 * The one `redirectSafeFetch` of a remote server, shared by its sessions and
 * requests, so an origin it redirects to is logged once, not per request.
 */
export const remoteFetch = (remote: RemoteServer, logger: Logger) => {
  let send = byRemote.get(remote)
  if (!send)
    byRemote.set(remote, (send = redirectSafeFetch(remote.headers, logger)))
  return send
}
