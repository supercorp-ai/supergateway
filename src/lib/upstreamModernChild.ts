import { parseJSONRPCMessage, type JSONRPCMessage } from './modernSdk.js'
import type { Logger } from '../types.js'
import type { RemoteServer } from './upstreamPeer.js'
import { encodedHeader, mirroredHeaders } from './modernHeaders.js'
import { getVersion } from './getVersion.js'

/**
 * What the 2026-07-28 relay needs of the server one request is for: a local
 * process (OwnedStdioTransport), or a remote server (below).
 */
export interface ModernChild {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  start(): Promise<void>
  send(message: JSONRPCMessage): Promise<void>
  /** After a notification: nothing more will be sent. */
  finish(): Promise<void>
  close(): Promise<void>
  /** Stop reading what the server says until `drained` settles. */
  hold(drained: Promise<void> | undefined): void
}

/**
 * A remote server, for one 2026-07-28 request. There is no session to open:
 * each message is a POST of its own, with the headers that mirror it, and
 * what the remote server answers (JSON, or an event stream) is delivered
 * message by message, as a local server's output is.
 *
 * The client's own headers are not passed on, its Authorization least of
 * all: the remote server gets --header and --oauth2Bearer, the version, and
 * the `mcp-param-*` mirrors of a tool call's arguments, which the relay has
 * checked against the tool's schema.
 */
export class UpstreamModernChild implements ModernChild {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private readonly aborting = new AbortController()
  private readonly reading = new Set<Promise<void>>()
  private held: Promise<void> | undefined
  private closed = false

  constructor(
    private readonly remote: RemoteServer,
    private readonly request: {
      /** The version the client's request declared. */
      version: string | undefined
      /** The client's `mcp-param-*` headers. */
      params: Record<string, string>
    },
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {}

  hold(drained: Promise<void> | undefined): void {
    this.held = drained
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.closed) throw new Error('Upstream request is closed')
    const call = 'method' in message && message.method === 'tools/call'
    const response = await fetch(this.remote.url, {
      method: 'POST',
      signal: this.aborting.signal,
      headers: {
        ...this.remote.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...(this.request.version === undefined
          ? {}
          : { 'mcp-protocol-version': encodedHeader(this.request.version) }),
        ...mirroredHeaders(message),
        ...(call ? this.request.params : {}),
      },
      body: JSON.stringify(message),
    })
    const awaited =
      'id' in message && 'method' in message ? message.id : undefined
    const reading = this.read(response, awaited)
      .catch((error: Error) => this.fail(error))
      .finally(() => this.reading.delete(reading))
    this.reading.add(reading)
  }

  async finish(): Promise<void> {
    await Promise.all(this.reading)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.aborting.abort()
    this.onclose?.()
  }

  private fail(error: Error) {
    if (this.closed) return
    this.logger.error('Upstream request failed:', error)
    this.onerror?.(error)
    void this.close()
  }

  // Everything one response carries. A request must be answered by it: a
  // remote server that ends its answer without one has failed the request.
  private async read(response: Response, awaited: unknown) {
    const type = response.headers.get('content-type') ?? ''
    let answered = awaited === undefined
    const deliver = (value: unknown) => {
      const message = parseJSONRPCMessage(value)
      if ('id' in message && !('method' in message) && message.id === awaited)
        answered = true
      this.onmessage?.(message)
    }
    if (type.includes('text/event-stream')) await this.events(response, deliver)
    else if (type.includes('application/json')) deliver(await response.json())
    else if (!response.ok)
      throw new Error(`The remote server answered ${response.status}`)
    if (!answered)
      throw new Error('The remote server ended its answer without a reply')
  }

  // An event stream's messages: each event's `data` lines are one message.
  private async events(response: Response, deliver: (value: unknown) => void) {
    const decoder = new TextDecoder()
    let buffered = ''
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true })
      const events = buffered.split(/\r?\n\r?\n/)
      buffered = events.pop()!
      for (const event of events) {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n')
        if (data) deliver(JSON.parse(data))
      }
      // No faster than the client reads.
      await this.held
    }
  }
}

/** The protocol version the relay speaks, and asks a remote server about. */
export const MODERN_VERSION = '2026-07-28'
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
