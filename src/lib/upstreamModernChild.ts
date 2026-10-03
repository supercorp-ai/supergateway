import { parseJSONRPCMessage, type JSONRPCMessage } from './modernSdk.js'
import type { Logger } from '../types.js'
import type { RemoteServer } from './upstreamPeer.js'
import { encodedHeader, mirroredHeaders } from './modernHeaders.js'

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
