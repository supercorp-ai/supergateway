import { isSensitiveHeader } from './headers.js'

/**
 * The URL as it may be logged or shown to a client: any user name and password,
 * and the values of query parameters with sensitive names (`token`, `api_key`,
 * …), are replaced.
 */
export const redactUrl = (url: URL): string => {
  const parsed = new URL(url.href)
  if (parsed.username) parsed.username = 'redacted'
  if (parsed.password) parsed.password = 'redacted'
  for (const key of new Set(parsed.searchParams.keys()))
    if (isSensitiveHeader(key)) parsed.searchParams.set(key, 'redacted')
  return parsed.href
}

/**
 * The upstream URL, refused if it carries a user name or password.
 *
 * fetch refuses such a URL ("Request cannot be constructed from a URL that
 * includes credentials: <the whole URL>"), so it never connected, and that
 * message put the password in the log and, from the SSE bridge, in the error
 * sent to the stdio client. Failing at startup with the URL redacted says the
 * same thing without the password. Sending them as Basic auth instead would be
 * a new feature, parked with the CLI flags plan.
 */
export const parseUpstreamUrl = (url: string): URL => {
  const parsed = new URL(url)
  if (parsed.username || parsed.password)
    throw new Error(
      `Credentials in the upstream URL are not supported: ${redactUrl(parsed)}. Send them as a header instead, e.g. --header "Authorization: Basic <base64 of user:password>".`,
    )
  return parsed
}
